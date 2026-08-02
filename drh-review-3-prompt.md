# DRH Review #3: Score Plateau at ~4.0 — What's the Next Breakthrough?

## Progress Since Review #2 (12h ago)

We implemented all 5 DRH recommendations:
1. ✅ Search result caching (eliminates variance)
2. ✅ Fixed broken search (DDG→jina.ai proxy)
3. ✅ Deterministic proxies for 4 juror-only criteria (broke 4.0 ceiling)
4. ✅ Optimizer steering away from search.ts
5. ✅ Subsystem metrics

## Current State (13 iterations of 20 complete)

### Score trend
```
Before fixes:     2.65 (broken search, 0 corroboration)
After search fix: 3.19-3.22
After DRH proxies: 3.76-3.98
Peak:             4.16
Latest:           3.68-4.08 (fluctuating around 4.0)
```

### Commits this session
- Search fix: DDG via jina.ai reader proxy (was completely unreachable)
- Search caching: DR_SEARCH_CACHE env var freezes results between baseline/patched
- DRH proxies: analytical_depth, timeliness, structure_actionability, conciseness
- metrics.ts: claim-graph "supports" edges count as corroboration
- orchestrator.ts: prioritizePairs by independent source families
- claimgraph.ts: claimTextSimilarity export + relation pair prioritization
- audits.ts: citation number extraction improvement

### What the optimizer kept (across 13 iterations)
Patches to: metrics.ts, orchestrator.ts, claimgraph.ts, audits.ts, prompts.ts
Discarded: various search.ts patches (cached, no effect), controller.ts, prompts.ts (single-line)

## The Plateau Problem

Score is stuck around 4.0 (out of 5.0). The variance is ±0.2 from LLM non-determinism.

### Proxy score breakdown (typical good run)
```
factual_accuracy:     3.6  (corroboration ~65%)
citation_integrity:   4.0  (pass rate ~80%)
source_quality:       4.0  (18 publishers)
coverage:             4.0  (5/7 dimensions)
contradiction_handling: 4.0
analytical_depth:     4.5  (170+ corroborated claims)
timeliness:           3.5  (mixed year references)
structure_actionability: 4.0
conciseness:          3.0  (15 words/claim)
```

Weighted composite: ~4.0

### Where the points are left on the table
1. **factual_accuracy** (weight 0.20): 65% corroboration → score 3.6. Getting to 80% would give 4.2.
2. **citation_integrity** (weight 0.20): 80% pass rate → score 4.0. Getting to 100% gives 5.0.
3. **conciseness** (weight 0.05): 15 words/claim → score 3.5. This proxy might be miscalibrated.
4. **timeliness** (weight 0.05): 3.5. Depends on how many 2024+ references the report cites.

## Key Questions

1. **Is 4.0 a natural plateau for this architecture, or is there a structural change that could push to 4.5+?**

2. **The citation pass rate varies 68-100% across runs. This is the most volatile high-weight metric. Should we focus the optimizer entirely on citation consistency?** The audits.ts patch helped but didn't solve it.

3. **The conciseness proxy (5 - wordsPerClaim * 0.1) might be counterproductive — it rewards terse claims but terse claims may lose important nuance. Should we recalibrate or remove it?**

4. **LLM non-determinism is still causing ±0.2 score variance even with cached search. Should we set temperature=0 for the candidate model (gpt-5.5)? DRH noted that even temp=0 has variance, but it would reduce it.**

5. **Should we launch a second workflow on a DIFFERENT topic to test generalization? The SMR topic may be overfit.**

6. **The optimizer keeps producing patches to orchestrator.ts and claimgraph.ts. Should we restrict it to prompts.ts only for a few iterations to see if prompt improvements move the needle on citation quality?**

## Current Proxy Formulas
```typescript
factual_accuracy: 1 + corroboratedFraction * 4
citation_integrity: round(citationPassRate * 5)
source_quality: round((1 - publisherConcentration) * 5)
coverage: round(dimensionsCovered / dimensionsTotal * 5)
contradiction_handling: acknowledged ? 4 : detected ? 2 : 3
analytical_depth: 1 + log2(corroboratedClaims) * 0.5
timeliness: 1 + (recentYearFraction) * 4
structure_actionability: 1 + headings * 0.15 + (hasRecommendations ? 1.5 : 0)
conciseness: 5 - wordsPerClaim * 0.1
```

Weights: factual=0.20, citation=0.20, source=0.15, coverage=0.15, contradiction=0.10,
analytical=0.05, timeliness=0.05, structure=0.05, conciseness=0.05
