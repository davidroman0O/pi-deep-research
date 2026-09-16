# Judge Calibration Gate

Validates the juror instrument against adversarial perturbation pairs BEFORE trusting judge verdicts (DRH review 5, prescription P0-2: "validated judge, not strong judge").

## Pairs (generated from the conserved SMR ours_report.md)

| Pair | Perturbation | Expected discrimination |
|---|---|---|
| verbosity-padding | 6x filler paragraph inserted after every section heading | conciseness(degraded) <= conciseness(strong) |
| citation-padding | citation-stacking [1] appended to first 12 citations | citation_integrity(degraded) <= strong |
| unit-confusion | three $/kW figures scaled x1000 | factual_accuracy(degraded) <= strong - 1 |
| source-degradation | first 6 multi-citations collapsed to [1] | source_quality(degraded) <= strong |

## Run

    bun test/gate/judge-calibration-generate.mjs   # builds blind prompts (randomized A/B order)
    # per pair: gpt_chat with .cal-<pair>.md, judge model + effort, save cal-<pair>-response.md
    bun test/gate/judge-calibration-evaluate.mjs  # parses tables vs orders.json, emits calibration-report.json

## Latest result

gpt-5-6-thinking @ max: **4/4 detected** (2026-09-15, calibration-report.json). Position swaps randomized; no position-bias failure observed.

## Re-run cadence

Whenever the judge model/effort changes, or every ~10 judge verdicts (drift check).
