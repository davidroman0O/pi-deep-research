# pi-deep-research

A deep-research harness built from Pi primitives — implementing the reference
architecture (spec → task graph → parallel search/ingest/extract → claim graph
→ contradiction detection → confidence → synthesis → citation & quality audits)
as a **Pi extension** that runs on the user's own configured models and providers.

No text-heavy skill, no delegation to a third-party DR product. The `dr_research`
tool *is* the harness: the orchestrator drives the whole loop programmatically,
and every LLM step is a native tool call (schema-enforced via pi-ai constrained
sampling, `toolChoice` forced) against whatever model the user has active.

## Architecture

```
dr_research(topic, { profile: "standard" })
  │
  ├─ Phase 1  specification          tool call → research spec (objective, dimensions, freshness)
  ├─ Phase 2  decomposition          tool call → task graph (atomic subquestions, priorities)
  │
  ├─ Phase 3-5  DYNAMIC LOOP (per iteration)
  │     ready tasks (deps satisfied) ──── parallel (2 tasks) ────┐
  │       query gen (tool call)                                  │
  │       parallel search (N queries at once)                    │
  │       rank + dedup (canonical URL, content hash, SimHash)    │
  │       per source ─────── parallel (3 sources) ──────────┐    │
  │         ingest (backend-routed: HTML→scrapegraph/readability, PDF→pdf-parse) │
  │         trust layer (injection heuristics, secret redaction) │
  │         novelty gate (SimHash distance vs memory)            │
  │         passage selection (chunk → BM25 → budgeted context)  │
  │         EXTRACT (tool call, untrusted XML envelope)          │
  │         SOURCE MEMO (tool call — loss-aware summary)         │
  │       task memo (tool call — synthesized from source memos)  │
  │     gap check (tool call) → dynamic tasks (depends_on graph edges)
  │     stopping criteria (coverage / novelty saturation / budget)
  │
  ├─ Phase 6  claim graph            cluster evidence → claims; parallel relation
  │                                  classification (supports/contradicts/qualifies);
  │                                  confidence = logistic(independent sources,
  │                                  quality, directness, consistency, recency,
  │                                  − contradiction, − assumption sensitivity)
  ├─ Phase 6b topic syntheses        per-dimension conclusions (tool call)
  ├─ Phase 6c numeric normalization  comparison tables, exact conversions only,
  │                                  incomparable rows flagged (§18)
  ├─ Phase 7  sectioned synthesis    outline (tool call) → parallel section drafts
  │                                  with per-section evidence bundles (§21.1) →
  │                                  exec summary → assemble
  └─ Phase 8  audits + repair        citation entailment (per cited sentence) →
                                     citation repair (re-cite or hedge, §22.1) +
                                     8 static audits (coverage, claim, contradiction,
                                     freshness, numerical, source diversity, leakage, safety)
```

### Depth profiles

| Profile | Sources | Iterations | Queries/task | Citation checks | Report scale |
|---------|---------|-----------|--------------|-----------------|--------------|
| `quick` | ~10 | 4 | 3 | 12 | short brief |
| `standard` | ~25 | 12 | 4 | 25 | full report (default) |
| `deep` | ~40 | 20 | 5 | 30 | long-form, 8-13 sections |
| `heavy` | ~60 | 30 | 6 | 40 | maximal — rivals paid DR products |
| `ultra` | ~100 | 40 | 8 | 50 | beyond paid DR heavy — longest, strictest |

Explicit params (`breadth`, `max_sources`, `citation_checks`, …) override the preset.

### Memory tiers (on disk, `.pi/research/<runId>/`)

| Tier | Content | File |
|------|---------|------|
| 0 | Immutable source archive | `raw/s*.md` |
| 2 | Evidence ledger (atomic facts + provenance) | `evidence.jsonl` |
| 2/3 | Source memos, task memos | `source_memos.json`, `task_memos.json` |
| 5 | Spec, task graph, executive state | `run.json`, `tasks.json` |
| — | Claim graph | `claims.json`, `claim_edges.json` |
| — | Report + audits | `report.md`, `audit.json`, `log.jsonl` |

Everything writes through to disk each iteration: Esc interrupts safely,
`dr_research { resume: true }` picks the run back up.

### Prompt-injection defense (§24 of the reference design)

Every fetched byte is treated as **untrusted data**: content is scanned for
instruction-like patterns ("ignore previous instructions", role overrides,
exfiltration requests), secrets are redacted, and the model receives web content
only inside `<untrusted_source>` XML envelopes with an explicit instruction
hierarchy (system > user > tool output). Extractors report injected instructions
via a schema field; they're logged and surfaced in the safety audit.

## Backends (optional, key-gated)

| Role | Backends | Keys |
|------|----------|------|
| Search | `exa` (neural, exa-js), `tavily`, `scrapegraph`, `ddg` (no-key default) | `EXA_API_KEY`, `TAVILY_API_KEY` |
| Scrape | `scrapegraph` (markdown reader mode), `native` (fetch + Readability + Turndown; always used for PDFs via pdf-parse) | `SGAI_API_KEY` / `SCRAPEGRAPH_API_KEY` |

Backend routing is content-aware: PDFs always go native (pdf-parse) because
ScrapeGraph's reader mode can't process them; scrapegraph failures retry natively.

Configure via the extension command:

```
/research-config search exa scrape scrapegraph
/research-config key exa <key>
/research-config key scrapegraph <key>
/research-config paid off        # no-cost mode: ddg + native only
```

Or via `.env` / environment (`EXA_API_KEY`, `SGAI_API_KEY`, `TAVILY_API_KEY`).

## Install

```bash
pi install /path/to/pi-deep-research   # local
```

Requires at least one authenticated model in Pi (any provider — the harness uses
the active session model and resolves auth from Pi's ModelRuntime).

## Usage

In Pi:

```
Use dr_research to investigate: "Should remote Canadian mines use SMRs or enhanced geothermal?"
```

Tune budget per call: `breadth`, `depth`, `max_sources`, `max_iterations`.
Interrupt with Esc — state persists; resume with `dr_research { resume: true }`.

Commands:

- `/research` — list runs (status, sources, evidence counts)
- `/research <runId>` — inspect one run (claims, edges, report path)
- `/research-config` — show/set backends and keys

## Development

```bash
bun install
bunx tsc --noEmit -p tsconfig.json   # typecheck

# Full E2E (zero mocks): real model via Pi auth + real Exa + real ScrapeGraph
MODEL_REF="zai/glm-5-turbo" bun test/e2e.ts | tee logs/e2e-$(date +%H%M%S).txt
```

The E2E verifies every artifact on disk: spec, task graph, sources (with trust
metadata + fingerprints), evidence ledger, claim graph + edges, source/task
memos, report with inline citations, and a passing audit.

## License

MIT
