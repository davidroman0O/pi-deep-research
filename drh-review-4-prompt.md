# DRH Review #4: Multi-Topic V4 Progress

## V4 Results So Far (7 iterations of 20)

Multi-topic cycling: SMR → Solid-state batteries → Carbon pricing steel

### Scores by topic
```
SMR:              4.46, 4.00, 3.61  (best topic — most optimized)
Battery:          4.16, 4.16, 3.70  (good generalization)
Carbon steel:     3.94, 4.04, 4.20  (improving — latest best)
```

Score range across all topics: 3.61-4.46. Average ~4.0.

### V4 patches kept (5 of 7 iterations)
1. coverage.ts: absolute gap score (reqCount - satisfied) instead of fractional
2. controller.ts: collapsed state machine (skip intermediate states)
3. prompts.ts: extraction cap at 5 completion-test-relevant items
4. policy.ts + prompts-policy.ts: publisher names + atomic-proposition reasoning
5. claimgraph.ts: emissions→emission normalization (multi-topic specific)

### Key observation
The multi-topic approach is working — the optimizer found a topic-specific fix (emissions plural normalization) that single-topic SMR runs would never have surfaced. Scores are generalizing across topics.

## Current Proxy Formulas
```typescript
factual_accuracy: 1 + corroborationFraction * 4        // weight 0.20
citation_integrity: round(citationPassRate * 5)         // weight 0.20
source_quality: round((1 - publisherConcentration) * 5) // weight 0.15
coverage: round(dimensionsCovered/total * 5)            // weight 0.15
contradiction_handling: acknowledged ? 4 : ...          // weight 0.10
analytical_depth: 1 + log2(corroboratedClaims) * 0.5   // weight 0.05
timeliness: 1 + recentYearFraction * 4                  // weight 0.05
structure_actionability: 1 + headings*0.15 + rec*1.5    // weight 0.05
conciseness: 1 + evidenceDensity * 300                  // weight 0.05
```

## Questions

1. **Scores are plateauing at ~4.0-4.2 across all topics. The SMR topic peaked at 4.46. Is this the architectural ceiling you predicted, or is there room?**

2. **Citation pass rate is the most volatile metric (40-96%). It swings the composite by ±0.3. Should we focus the remaining iterations entirely on citation audit improvements?**

3. **The conciseness proxy (evidence density * 300) caps at 5 very easily — most runs get 4-5. Should we make it more discriminating or reduce its weight?**

4. **Should we run the LLM juror (gpt-5.6-sol blind pairwise vs DRH reference) now to calibrate the proxy scores? We have 3 topics with reports on disk.**

5. **The optimizer keeps trying extraction caps (8, then 5) and the measurement keeps going back and forth. Is there a principled way to determine the optimal extraction limit, or should we let it be unbounded?**
