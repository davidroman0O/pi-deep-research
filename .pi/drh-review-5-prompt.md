# Autoresearch Workflow Review (session 2) — pi-deep-research

You are reviewing an AUTONOMOUS EXPERIMENT CAMPAIGN that reverse-engineers ChatGPT Deep Research Heavy (you). Between your last review and now, the campaign ran 30+ experiments, added multi-domain benchmarks, conserved every artifact, and ran the first full blind juror gate against a DRH reference (gpt-6-astra-wm, max effort). Your job: review what we did, find flaws in the WORKFLOW (not just the pipeline), and prescribe the next cycle.

## What the campaign does now

- Measure loop: standard profile (25-src cap, 12 iters, 45-min wallclock, per-task wallclock slices, warm search cache for paired runs) -> deterministic metrics + reference-relative signals (fact_recall, depth_ratio vs a conserved DRH report) -> METRIC lines.
- Optimizer cycle: an optimizer agent (deepseek, xhigh) proposes one surgical patch per run; patch -> tsc -> 13 unit tests -> paired measure -> keep/discard by composite + targeted signals -> journal (experiment_log.jsonl, 51 runs).
- Judge gate: candidate report vs conserved DRH reference, two blind swapped jurors (gpt-5-6-thinking, max), aggregate -> ratio + hard gates + bias audit.
- Conservation: every run archives ours/drh reports (test/results/<slug>/ + history/), DRH references per topic, juror files, verdicts.
- Topic corpus: 20 regression topics across energy, AI policy, health, climate, and 10 DEEP FINANCE topics (private credit risk, CRE maturity wall, Basel III endgame, yen carry unwind, sovereign sustainability, PE exit drought, stablecoin run risk, Treasury basis trade, hyperscaler AI capex financing, cat-bond/ILS).

## Headline results

1. First blind judge: ours 3.50 vs DRH 4.78, ratio 0.733, DRH preferred both runs (high confidence). Per-criterion gaps: factual 3.5/5, citation 3.0/4.5, source_quality 3.5/5, coverage 3.5/5, contradiction 3.5/5, analytical 4.0/5, timeliness 4.5/5, structure 4.5/5, conciseness 3.0/2.5 (we beat DRH only there).
2. Campaign keeps that moved the deterministic signals: query-angle diversity (fact_recall 0.63->0.71), quality-gated citation_ready (fact_recall ->0.79, composite 4.2725), evidence-table appendix (depth_ratio ->1.0), scaled verify net, bounded repair loop, zero-ingest rotation, wallclock slicing.
3. Finance-domain generalization: first measurement with reference = composite 4.02, fact_recall 0.52 (vs 0.79 SMR), corroboration only 0.32-0.52 — competing market-size estimates are DISTINCT claims by design, so corroboration-as-ratio is structurally low on estimate-contested topics.
4. Operational wins: agent-turn connection cap killed long runs (fixed with direct in-process measurement), schema-array sanitizer (one crash class eliminated), section truncation guard + regeneration.

## The juror's specific findings (blind, both runs)

1. Weak/mismatched sources on load-bearing claims (Wikipedia for X-energy).
2. Unfinished sections shipped (fixed since: truncation guard + regeneration, verified in production).
3. Category mixing: programme budgets adjacent to OCC figures without basis labels.
4. Source hierarchy: secondary analyses where primary disclosures exist.
5. Repetition: ours repeats points across sections.

## Open workflow questions (answer these concretely)

A. Noise vs verdicts: single paired runs have ±0.10-0.15 composite noise; most micro-patches are indistinguishable. Is 2-run batching + targeted-signal gating the right fix, or should we move to a different verdict statistic?
B. Estimate-contested topics: corroboration-as-ratio structurally punishes topics where honest disagreement exists (finance). Should the metric count RANGE-claims (multi-source estimate spans) as corroborated? Is there a DRH-style canonical structure we should adopt for contested numbers?
C. Citation discipline: how does DRH decide what deserves a primary source vs a summary source? Should we gate citations by source quality at drafting time (already done for citation_ready) or at claim-graph time?
D. Finance fact_recall 0.52 vs SMR 0.79: which query/extraction behaviors does DRH use for market-size/estimate questions that we lack?
E. Workflow-level: our optimizer only sees per-run metrics. What feedback should flow BETWEEN iterations (juror findings -> optimizer memory) that we're not feeding it?
F. What are we NOT measuring that DRH optimizes for?

## Attachments

- experiment_log tail (last 12 runs, full JSON)
- verdict.json + juror-run1.json (blind scores + justifications)
- extensions/workflows.js (drOptimize/drJudge workflow source)
- src/orchestrator.ts (the pipeline)
- test/lib/metrics.ts (the measurement proxies)
- docs/internals/WORKFLOW_DESIGN.md (the original workflow design you reviewed)

## Output format

Sections: (1) workflow flaws ranked by expected impact, (2) concrete prescriptions per question A-F, (3) anything we should STOP doing, (4) the single highest-leverage change for the next cycle.