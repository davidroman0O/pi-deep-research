# DRH Strategic Review: Autoresearch Workflow Improvement

## Context

We're building `pi-deep-research` — a deep research engine that matches ChatGPT Deep Research Heavy quality. It runs as a Pi coding agent extension implementing a §14 dynamic research controller: spec → decompose → search → ingest → extract → claim graph → synthesis → audits.

## The Autoresearch Loop

We have an autonomous optimization workflow that:
1. **Measures baseline** — runs the full deep research pipeline on a fixed topic ("What is the current capital cost per kW of small modular reactors?") using gpt-5.5
2. **Launches optimizer** — gpt-5.6-sol (max thinking) reads ALL 19 source files + experiment log, proposes ONE targeted patch as a unified diff
3. **Applies patch** — git apply, tsc check, runs measure again
4. **Decides keep/revert** — keeps if `delta > 0.001` AND hard gates pass (factual_accuracy ≥ 3, citation_pass_rate ≥ 0.5)

## THE CORE PROBLEM: 7+ consecutive patches ALL discarded

The optimizer is finding REAL issues:
- Iter 1: Claim-graph "supports" edges not counted as corroboration in metrics
- Iter 2: Duplicate iteration counter in orchestrator (double-counting)
- Iter 3: (completed, result unknown)
- Iter 4-7: DDG search reliability — bot challenges, fallback to Brave/jina.ai reader proxy, regex parsing fixes

ALL were discarded because the measurement noise drowns out the signal.

## Root Cause: Measurement Variance

The `quality_score` composite is calculated from deterministic metrics:

```
RUBRIC_WEIGHTS = {
  factual_accuracy: 0.20,      // proxy: 1 + corroboration * 4
  citation_integrity: 0.20,    // proxy: citation pass rate
  source_quality: 0.15,        // proxy: publisher diversity
  coverage: 0.15,              // proxy: dimensions covered / total
  contradiction_handling: 0.10,// proxy: contradictions acknowledged
  analytical_depth: 0.05,      // ALWAYS 0 (juror-only)
  timeliness: 0.05,            // ALWAYS 0 (juror-only)
  structure_actionability: 0.05,// ALWAYS 0 (juror-only)
  conciseness: 0.05,           // ALWAYS 0 (juror-only)
}
```

**Corroboration variance**: 4-30% across identical-code runs. This comes from:
- DuckDuckGo search returning different results each run
- ScrapeGraph sometimes timing out on certain URLs
- The LLM (gpt-5.5) choosing different search queries / verify targets each run

Since `factual_accuracy = 1 + corroboration * 4` has weight 0.20, a corroboration swing from 10% to 30% changes `quality_score` by `0.20 * 4 * 0.20 = 0.16`. The keep threshold is `delta > 0.001` — but the noise floor is ±0.08 or more.

## Current Keep/Discard Logic

```javascript
const improved = delta > 0.001;
const gatesOk = (newMetrics.factual_accuracy ?? 0) >= 3 
             && (newMetrics.citation_pass_rate ?? 0) >= 0.5;

if (improved && gatesOk) {
  // KEEP
} else {
  // DISCARD
}
```

## What We Need

1. **How to make the measurement reliable enough to detect real improvements** — we can't afford multi-run averaging at 10min/run with 20 iterations. Should we:
   - Cache/freeze search results between baseline and patched measure?
   - Use a fixed-topic corpus instead of live search?
   - Change the decision logic to use statistical significance instead of raw delta?
   - Run N=3 baseline + N=3 patched and compare means?

2. **Should the optimizer target different areas?** — 4/7 patches targeted DDG search reliability. Should the prompt steer toward prompt quality (prompts.ts), claim clustering (claimgraph.ts), or synthesis quality instead?

3. **Is single-topic measurement fundamentally flawed?** — Should we use 3-5 diverse topics and measure average improvement? More topics = more reliable signal but slower iterations.

4. **Should we add intermediate metrics?** — e.g., measure claim clustering quality separately from end-to-end quality, so the optimizer gets signal on subsystem improvements without full pipeline noise.

5. **What's the best autonomous optimization loop architecture for a system with this level of measurement noise?**

## Current State
- 33 experiment log entries, 8 patches kept (from previous sessions)
- Corroboration improved from ~6% to ~46% over 8 kept patches
- Session results: quality_score 2.55→3.26, corroboration 10%→45.6%, citation_pass_rate 33%→84%
- But this session: 7+ consecutive discards because the measurement noise increased
- Cost: ~$40+ in optimizer calls (gpt-5.6-sol), ~$2-5 per measure run (gpt-5.5)

## Key Source Files

### src/metrics.ts (corroboration computation)
The corroboration check counts claims backed by ≥2 independent source families. It tries:
1. Direct source-family overlap
2. Claim-graph "supports" edges from independent families
3. Entity+value matching across all evidence

### src/claimgraph.ts (claim clustering)
Clusters evidence by `proposition_key` (canonical subject|predicate|value|date). Falls back to Jaccard token similarity for legacy slotless evidence.

### test/lib/metrics.ts (proxy scoring)
```typescript
export function proxyScores(m: RunMetrics): Record<Criterion, number> {
  return {
    factual_accuracy: 1 + m.corroboratedFraction * 4,  // 1-5 scale
    citation_integrity: 1 + m.citationPassRate * 4,
    source_quality: Math.min(5, 1 + (1 - m.publisherConcentration) * 4),
    coverage: m.dimensionsTotal > 0 
      ? 1 + (m.dimensionsCovered / m.dimensionsTotal) * 4 : 1,
    contradiction_handling: m.contradictionsAcknowledged ? 5 : 1,
    analytical_depth: 0, timeliness: 0,
    structure_actionability: 0, conciseness: 0,
  };
}
```

### The full pipeline (src/orchestrator.ts, 1058 lines)
```
dr_research(topic, { profile: 'benchmark' })
  Phase 1: specification (LLM tool call → research spec)
  Phase 2: decomposition (LLM tool call → task graph)
  Phase 3-5: DYNAMIC LOOP (controller action loop)
    refresh coverage matrix → should_stop? → select_next_task → choose_action → execute
  Phase 6: claim graph (cluster evidence → claims; relation classification)
  Phase 7: sectioned synthesis (outline → parallel section drafts → assemble)
  Phase 8: audits + repair (citation entailment + 8 static audits)
```

## Constraints
- No human in the loop — fully autonomous
- Cost doesn't matter
- Time: 24h budget per workflow run
- Must use real Pi sessions (createAgentSession), not bypass the harness
- Must use native tool calls (pi-ai constrained sampling), no prose JSON parsing
