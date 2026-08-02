# AGENTS.md — pi-deep-research

## Git Safety Rules (CRITICAL)

The user does ALL git commits. Agents must NOT commit.

When testing patches in workflow scripts or inline scripts:

- **ONLY** use `git apply` and `git apply -R` with a specific patch file
- **NEVER** use `git checkout --`, `git reset --hard`, `git stash`, `git clean`, or `git restore`
- These commands revert ALL uncommitted changes, destroying kept patches from previous iterations
- If `git apply` fails on whitespace, use `git apply --ignore-whitespace`
- If that fails, use `patch -p1 --fuzz=3`
- Always revert with the same method used to apply

## Architecture

pi-deep-research is a deep-research extension for Pi, implementing a §14 dynamic
research controller. The `dr_research` tool drives: spec → decompose → search →
ingest → extract → claim graph → synthesis → audits.

Key source files in `src/`:
- `orchestrator.ts` — main research loop, action dispatch
- `controller.ts` — task state machine, completion tests, safety guards
- `prompts.ts` — content-generation prompts (spec, extract, synthesize)
- `metrics.ts` — quality measurement (corroboration, citation, coverage)
- `claimgraph.ts` — claim clustering + corroboration detection

Test infrastructure in `test/`:
- `lib/` — shared types, session factory, artifact manager, metrics
- `runners/` — candidate (Pi session), reference (DRH cache), juror (blind pairwise)
- `gate/` — verdict aggregation, threshold calibration, bias audit
- `suites/` — smoke, regression, judge, autoresearch-measure
