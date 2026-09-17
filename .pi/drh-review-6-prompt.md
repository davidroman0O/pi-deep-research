# pi-deep-research workflow review #6 — recalibration execution audit

You are reviewing a deep-research system (Pi extension "pi-deep-research") that reverse-engineers ChatGPT Deep Research Heavy. It runs a §14 dynamic research controller (spec → decompose → search → ingest → extract → claim graph → synthesis → audits) and is optimized by an autonomous agent via measurable proxies, with a blind-judge gate vs conserved DRH references.

## What changed since review #5 (your predecessor's prescriptions, all adopted)
1. Proxy-directed micro-patching FROZEN (your finding: single-run keeps at Δ>0.001 under ±0.15 noise ≈ 50% false-keeps).
2. Judge calibration fixture: 4 adversarial perturbation pairs (verbosity padding, citation spam, unit confusion, source degradation), blind juror with position randomization discriminated 4/4 in expected direction. Permanent gate.
3. Verdict aggregation provenance: aggregateVerdict emits formula/weights/per-run juror composites; regression test pins the juror-self-composite-vs-formula difference (3.75 vs 3.50).
4. Typed fact matching: fact_recall reference facts now carry unit context; matches require same-line unit co-occurrence ($4,000M can no longer false-match $4,000/kW).
5. Corroboration structure: corroboratedClaims requires families>=2 OR supports edge to different family OR entity+value match to different family — duplicates (same family) never corroborate; contradicts/qualifies edges preserved in claim graph.

## Your review #5 remaining queue (in your order)
- Evidence polarity audit: verify duplicates never count as corroboration, contradicts/qualifies are preserved evidence not noise, split corroboration accounting into independent_support vs disagreement_handling.
- Three evaluation pools: 8 dev / 6 shadow / 6 sealed topics, sequential topic-clustered gate instead of single-topic medians.
- Entity-slot queries + claim-type-aware source adequacy for finance topics.
- Historical-keep re-audit LAST (as checkpoints, not 51 re-verdicts).

## Questions for this review
1. Evidence polarity: is "split corroboration into independent_support vs disagreement_handling accounting" the right minimal change, or should disagreement_handling only gate contradiction_handling scoring? What is the smallest instrument change that captures it without destabilizing the frozen composite scale?
2. Pool assignment: 20 topics exist (10 finance, all deep/multi-dimensional; 10 general). Is 8/6/6 dev/shadow/sealed with finance spread across all three pools correct, or should finance be a stratification variable within each pool? Sealed pool: should it be locked until the recalibrated gate first passes on dev+shadow?
3. After pools + polarity land, what is the FIRST legitimate optimization target under the unfrozen gate (entity-slot queries? verify-target typing? something you now see that we do not)?
4. Any risk that the typed fact matching (item 4 above) over-tightens recall on legitimately reformatted numbers (e.g. "$4,000 per kilowatt" vs "$4,000/kW" — same line, unit spelled out)?

## Code context (key files)
- src/metrics.ts: corroboration (families>=2 / supports-edge / entity+value fallback)
- src/claimgraph.ts: clustering, duplicate-only complete-link coalescing, relation preservation (supports/contradicts/qualifies/duplicate edges kept)
- test/lib/metrics.ts: proxyScores + referenceSignals (fact_recall typed matching, depth_ratio, narrativeOnly appendix stripping)
- test/runners/juror.ts: aggregateVerdict with provenance
- test/gate/: verdict.ts, threshold.ts, bias-audit.ts, calibration fixture
- test/regression/: 20 topic JSONs (10 finance-*, 10 general)
- experiment_log.jsonl: 53 runs, kept tree = query rotation + citation repair + wallclock slicing + extract maxItems 8 + evidence appendix + verify net scaling + query-angle diversity

Answer with concrete, implementable prescriptions. Rank by (instrument validity gain) / (implementation cost). Be specific about what NOT to do.