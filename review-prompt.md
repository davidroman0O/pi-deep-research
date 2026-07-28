# Architecture & Design Review Request

You are reviewing a deep-research system architecture and its implementation. This is a **design review**, not a new research task. Do not search the web — everything you need is in the attached files.

## What's attached (the `files`)

Three layers:

1. **`chatgpt-transcript.md`** — a detailed reference design for a deep-research system (28+ sections: specification, task graphs, memory tiers, claim graphs, contradiction detection, the dynamic research loop, action selection, stopping criteria, synthesis, audits, multi-agent variants, prompt-injection defense). **Treat this as the authoritative spec.**

2. **`DESIGN.md`** — my architecture document. It reflects on where the current implementation diverges from the spec, and proposes a redesign: an agentic control loop with a `verify` action for corroboration, specialist roles, memory hierarchy as the retrieval path, and four resolved design calls (§11).

3. **All source files** (`orchestrator.ts`, `policy.ts`, `prompts-policy.ts`, `prompts.ts`, `store.ts`, `llm.ts`, `search.ts`, `ingest.ts`, `trust.ts`, `novel.ts`, `claimgraph.ts`, `quality.ts`, `passage.ts`, `parallel.ts`, `metrics.ts`, `audits.ts`, `config.ts`, `types.d.ts`, `research.ts`) — the current implementation.

## Your review task — answer these, citing section numbers from the transcript

**A. Faithfulness.** Does `DESIGN.md` faithfully implement the reference design in `chatgpt-transcript.md`? Where does it diverge, and are those divergences justified or mistakes? Cite specific sections ("§14 demands X but the design does Y").

**B. The agentic control loop (DESIGN §2).** Is it sound? Specifically: the inner task loop with `choose_action`, the `verify` action for corroboration, the planner-as-orchestrator-loop decision (§11.1), and the map-reduce-via-memory parallelism model (§7). What are the failure modes? What would you change?

**C. The corroboration problem (DESIGN §8).** The current build achieves only 4% multi-publisher corroboration vs near-100% for production deep-research. Is the four-part fix (verify action + corrected novelty gate + per-task `required_evidence` + coverage matrix corroboration column) sufficient? What's missing?

**D. Specialist roles (DESIGN §7).** Which roles genuinely need isolation, and is the "isolated only where judgment is adversarial" rule correct? Are there roles misclassified?

**E. The memory hierarchy (DESIGN §4).** Is "retrieval flows through the tiers, each is an index into the one below" the right model, or does strict hierarchy lose information that direct retrieval would preserve?

**F. Genuine gaps.** Anything in the reference design that NEITHER the current code NOR the DESIGN.md addresses.

**G. Prioritized recommendations.** What should be built first, what's risky, what's over-engineered.

## Output format

A structured review report with one section per question (A–G). Be specific, critical, cite section numbers. Push back where the design is wrong or hand-wavy. Prioritize correctness over politeness — this review guides the next implementation phase.
