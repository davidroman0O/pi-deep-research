# pi-deep-research — Architecture Design Document

> **Status:** iteration complete — ready for our discussion. This is where
> I thought out loud, as the architect, about *how this system should actually
> work*. Every claim is grounded in a section of the ChatGPT transcript
> (`logs/transcript.md` seed + the full design at
> `~/Downloads/Jul 26, 2026 09-25-15 PM Markdown Content.md`). Where I diverge,
> I say so and justify it. The four calls I'd been tempted to punt to you are
> resolved in §11 — push back on any of them, but the doc ships without holes.

---

## 0. Where the current build actually stands (honest baseline)

The code in `src/` implements most of the transcript's *mechanics* — spec,
task graph, parallel search/ingest/extract, claim graph, contradiction edges,
confidence, §18 normalization + scenarios, sectioned synthesis, citation
entailment audit, prompt-injection defense, backends (Exa/ScrapeGraphAI).

But it is **a deterministic pipeline with LLM content-fills, not an agent.**
The model decides *what the spec says*, *what the queries are*, *what the
evidence is*, *what the report says*. It does **not** decide:

- which task to research next (priority-sort, §16 gap score not used),
- what action to take on a task (fixed sequence: query→search→ingest→extract→memo),
- when a task is actually done (a gap-checker boolean, not "sufficient evidence?"),
- when to stop (budget caps + novelty saturation, not marginal-EIG),
- whether to seek corroboration for a single-sourced claim (impossible — no `verify` action, and the novelty gate *kills* corroborating sources).

Measured consequence: on the SMR topic, **4% of claims were corroborated by
≥2 independent publishers** vs DR-heavy's near-100%. The architecture is
capable of 100–150 sources; I've been starving it at 6 and locking its
control flow. That's the core failure this document has to resolve.

The fix is **not** "more code features." It's a different control structure:
a real reasoning loop driven by agent judgment over an external memory,
with specialist roles invoked where isolation buys quality. The rest of this
document designs that.

---

## 1. The core decision: agent judgment vs deterministic code

The transcript is explicit and I'd been ignoring half of it:

- **§14** `choose_action(task, memory) ∈ {search, open, read, extract, compute, verify, summarize, write, stop}` — *the model picks the next action.*
- **§15** the policy maximizes `EIG × Importance × SuccessProbability / (Cost + Latency + Risk)` — *the model estimates information gain qualitatively.*
- **§26** "one capable model plus a structured external state machine is more reliable than an unconstrained committee" — *isolation has a cost; don't spawn agents reflexively.*

**My resolution:** split responsibilities by *kind of judgment*:

| Responsibility | Kind of judgment | Owner |
|---|---|---|
| Document fetch, parse, chunk, dedup, rank | none — mechanics | **deterministic code** |
| Spec content, query wording, evidence text, report prose | generation | **stateless LLM call** (current approach, fine) |
| *Which task next, which action next, is-this-done, should-stop* | **persistent strategic reasoning over the whole memory** | **reasoning agent** |
| Contradiction investigation, source-quality evaluation, citation entailment | *adversarial* judgment (must not share the writer's optimism) | **isolated specialist agent** |
| Numeric normalization, scenario projection | semi-mechanical | **stateless LLM call + code validation** |

The first two are fine as-is. **The middle two are what's missing**, and the
last row is where I over-spawn today (every section is a parallel agent —
that's actually appropriate for isolation, keep it).

---

## 2. The control loop (replaces the current fixed pipeline)

The transcript's §14 pseudocode, adapted to Pi and made concrete:

```
spec ← specify(request)                          # stateless LLM
task_graph ← decompose(spec)                     # stateless LLM, builds DAG with
                                                 #   per-task required_evidence + uncertainty
memory ← initialize(spec, task_graph)            # on-disk store (already exists)

loop:
    refresh_coverage_matrix(memory)              # §16 — deterministic, from evidence + claim graph
    update_claim_graph_edges(memory)            # §11/12 — incremental, mechanical (supports/qualifies
                                                 #   via clustering); NOT the adversarial investigation
    refresh_uncertainty(memory)                  # §19 — deterministic, from corroboration features

    if should_stop(memory, budget):              # §20 — agent decides max-EIG, code applies caps
        break

    task ← select_next_task(memory)              # §16 — agent, reads coverage matrix,
                                                 #   picks highest Importance×(1−Coverage)×Uncertainty
    loop over task until completion_test_satisfied(task, memory):
        action ← choose_action(task, memory)     # §15 — agent, picks search/read/verify/extract/...
        observation ← execute(action)            # code: search API, fetch, parse, python
        evidence ← extract + normalize(observation, task)
        memory.store(observation, evidence)
        memory.update_claim_graph(evidence)
        discover_new_tasks(memory, task)         # §14 — agent proposes, planner gates (see §5)
        task.search_attempts += 1

    mark task done; write task memo              # §13.3 — compress this task's work

# ── post-loop passes over the WHOLE evidence base (§28 temporal separation) ──
global_normalize_claims(memory)                 # §9.2 — canonicalize across all evidence
contradictions ← investigate_contradictions(memory)  # §12 — ISOLATED specialist, adversarial
scenarios ← model_scenarios(memory)             # §18 — stateless call + code validation
report ← synthesize(memory, contradictions, scenarios)  # §21 — sectioned, evidence-constrained
report ← audit(report, memory)                  # §22/23 — isolated citation auditor + 8 audits
```

**Key differences from today:**

1. The inner `loop over task` is new. Today, one pass of (query→search→ingest→extract→memo) per task. The transcript's agent **stays on a task until its completion test is satisfied** — which is what enables `verify` (re-search for corroboration) and `read_deeper` (go back to a source) as real actions rather than one-shot.
2. `select_next_task` reads a **coverage matrix**, not a priority number.
3. `should_stop` is agent-judged EIG, not budget-only.
4. `discover_new_tasks` runs **inside the task loop**, not once per iteration.

---

## 3. The task node (§4.1 — I'd been under-modeling it)

Today: `{id, question, priority, status, depth, completion_test, depends_on}`.

The transcript wants:

```
{
  task_id, question, dependencies[], status,
  priority,            # static, from decompose (importance)
  coverage,            # DYNAMIC — fraction of required_evidence satisfied (code, §16)
  uncertainty,         # DYNAMIC — from claim graph (§19 formula, code-computed)
  expected_value,      # DERIVED — priority × (1 − coverage) × uncertainty; the §16 gap score,
                      #   used by select_next_task. Not stored independently — recomputed
                      #   each selection from the three values above.
  required_evidence: [ # per-task policy, set at decompose (§4.1)
    "≥2 independent primary sources",
    "≥1 quantitative figure with stated conditions",
    "no unresolved contradiction"
  ],
  completion_test,     # "Do I possess sufficient evidence?" not "Did I search?" (§4.2)
  search_attempts      # anti-loop guard (§20)
}
```

**Note on `expected_value`:** it is *not* a fourth stored field — it's the
§16 gap score, derived from the other three each time the planner selects a
task. Storing it would let it go stale. The node stores the *inputs*
(priority static, coverage + uncertainty dynamic); the selection reads those
and computes the score. This keeps "what the task is" (stored) separate from
"how badly we need it right now" (computed).

**Why this matters:** without `required_evidence` and a dynamic `coverage` +
`uncertainty`, the agent has no way to *judge task completion* the way §4.2
demands. "Did I search?" is the weak-agent test. "Do I possess sufficient
evidence?" requires the task to *declare what sufficient means*. That
declaration is `required_evidence`, and `coverage` measures it.

**Who updates `uncertainty`?** Deterministic code, from the claim graph (§19
formula: logistic over independent-source count, source quality, consistency,
minus contradiction). The agent *reads* it; it doesn't estimate it. This is
deliberate — §19 says model self-confidence is *not* a probability of truth;
the evidence-feature score is more defensible. So uncertainty is code-computed,
agent-consumed.

---

## 4. The memory hierarchy (§13 — make it the actual compression engine)

Today I have source memos and task memos but they're somewhat decorative —
section drafts read a claims digest directly. The transcript's §13.3 is a
**strict retrieval hierarchy**:

```
Tier 0  raw documents          (on disk: raw/s*.md)              ← have it
Tier 1  passage index          (chunked, BM25-rankable)          ← have it (passage.ts)
Tier 2  evidence ledger        (atomic facts + provenance)       ← have it
Tier 3  task summaries         (per-subquestion findings)        ← have it
Tier 4  topic syntheses        (per-dimension conclusions)       ← have it
Tier 5  executive state        (objective, gaps, key claims)     ← PARTIAL
```

**The fix isn't new tiers — it's making retrieval flow *through* them.** Today
the synthesis skips Tier 3/4 and reads Tier 2 directly. The transcript wants
section drafts to read Tier 4 (topic syntheses), which were built from Tier 3
(task memos), which were built from Tier 2 (evidence). Each level is "an index
into the one below, never a replacement." This is the compression that lets
100–150 sources fit: the writer never sees raw evidence, it sees compressed
conclusions that *point back* to evidence on demand.

**When is each tier refreshed?**

| Tier | Triggered by | Agent or code |
|---|---|---|
| 0 raw | every successful ingest | code |
| 1 passage index | every ingest | code |
| 2 evidence | every extract action | agent (extraction call) |
| 3 task memo | task completion (`completion_test_satisfied`) | agent — this is the per-task compression |
| 4 topic synthesis | end of research phase, before synthesis | agent — one pass grouping claims by dimension |
| 5 executive state | every loop iteration (coverage matrix lives here) | code + agent |

So compression is **event-driven, not periodic.** A task memo is written once,
when the task is judged complete. It doesn't get rewritten every iteration.

---

## 5. When does the task graph refine? (my question #1, resolved)

The transcript says "continuously." I was scared of the cost. The resolution:

**Refinement happens at three distinct granularities, each with a different
trigger and a different decider:**

1. **Sub-task spawning (within a task)** — when the researching agent, mid-task,
   discovers a sub-question it can't answer with the current task's scope
   (e.g. researching "SMR costs" and learning licensing timelines matter).
   *Decider:* the researching agent itself, via a `discover_subtasks` output on
   its action tool. *Gating:* the planner role reviews proposed sub-tasks
   against the gap-score rubric before they enter the graph (§26 committee-guard).
   *Cost:* one extra field on an action call — cheap.

2. **Cross-task gap-filling (end of iteration)** — the coverage matrix reveals
   an uncovered dimension or a single-sourced high-importance claim.
   *Decider:* the planner role, reading the coverage matrix.
   *Cost:* one planner call per iteration — what I have today, but fed real
   coverage data instead of a free-form gap check.

3. **Full re-decomposition (rare)** — when the spec itself is revealed to be
   wrong (e.g. the user's question assumed a framing the evidence contradicts).
   *Decider:* the planner, escalating to the user if it would change the objective.
   *Cost:* high; gated behind a confidence threshold so it fires maybe once a run.

**The balance:** (1) is cheap and frequent, (2) is medium and per-iteration,
(3) is rare and expensive. This matches the transcript's "after reading a few
sources it realizes [new dimensions]" — that's (1), the within-task discovery,
which I was entirely missing.

---

## 6. Who adds tasks, and why? (my question #3, resolved)

Two sources of new tasks, two different mechanisms:

- **Researching agent proposes** (within-task, §14 `discover_new_tasks`).
  It's the one reading sources, so it's the one that notices "this introduces
  a dimension I don't have a task for." It proposes via its action tool.
  **The proposal is gated** — it doesn't enter the graph automatically. The
  planner role (next section) accepts/rejects based on the gap rubric. This
  is the §26 committee-guard: agents can *propose*, the state machine
  *decides*.

- **Planner fills gaps** (cross-task, §16). Reads the coverage matrix,
  proposes tasks for uncovered dimensions or single-sourced claims. This is
  the only path that can raise a task's priority above the decompose-time
  default — researching agents can't self-promote (prevents loops).

**Anti-loop:** `search_attempts` per task, hard cap, plus the §20 stop rule.
A task that keeps spawning sub-tasks without reducing its own uncertainty gets
force-completed with its gaps disclosed (§20: "stopping is not the same as
proving the answer is complete; the report discloses unresolved gaps").

---

## 7. Specialist roles (my question #5, resolved) — where isolation earns its cost

§26 lists 8 roles. I'd been treating "army of agents" as "spawn everything."
The transcript warns against that. **Isolation is justified only where a
role's judgment is adversarial to another's** — i.e. a checker shouldn't
share the writer's bias. Mapping each role:

| Role | Isolated agent? | Why |
|---|---|---|
| **Lead/planner** | yes, persistent | holds the executive state; the one mind that watches the loop |
| **Search specialist** | no — an *action* of the researching agent | search is mechanics + query wording, no isolation benefit |
| **Source evaluator** | yes, isolated | judges quality *independently* of the extractor's enthusiasm |
| **Quantitative analyst** | no — stateless call + code | normalization is semi-mechanical; code validates |
| **Contradiction investigator** | yes, isolated | must be skeptical; sharing context with the writer biases it toward agreement |
| **Domain reviewer** | optional, isolated, late-stage | only for high-stakes topics; fresh-eyes critique of the draft |
| **Report writer** | yes (sectioned, parallel) | already do this — sections are isolated drafts |
| **Citation auditor** | yes, isolated | adversarial checker, must not trust the writer |

So: **one persistent planner agent** drives the loop; **multiple researching
workers** execute tasks concurrently (each worker is a fresh-context agent
or an action-sequence over one task — see below); **isolated specialist
agents** fire for evaluation, contradiction, and auditing. That's "an army
when needed, one agent when that's enough" — exactly what you said.

**Planner vs worker parallelism (the tension I have to resolve):** a single
researching thread starves breadth (you don't get 100–150 sources serially).
So the planner *dispatches* tasks to N concurrent workers. But the transcript's
§26 warns against committee chaos. The resolution: workers don't coordinate
with each other — they write to the shared memory and read the coverage matrix.
Coordination is *via the memory*, not via messages. This is the map-reduce
shape from §8 ("many detailed inputs reduced into progressively higher-level
representations"): workers are the map, the planner + specialists are the
reduce. A worker never decides global priority; it only decides actions on
*its* task. The planner decides who runs next.

**Pi-primitive mapping:** the planner is a long-lived reasoning loop (a
subagent with persistent context, or the main orchestrator making sequential
`complete()` calls with the executive state re-loaded each turn — the latter
is simpler and avoids signed-thinking issues; the on-disk memory makes either
coherent). Workers are **fresh-context subagents** dispatched in parallel
via Pi's `subagent` tool — each gets one task + the relevant memory slice,
runs to its completion test, writes back. Isolated specialists are the same
primitive, one judgment each. **One primitive (`subagent`), three usage
patterns** (persistent planner, parallel worker, isolated specialist) — that
keeps the implementation honest.

---

## 8. The corroboration problem (my question #6, resolved) — and why it's the real quality lever

This is the single most important fix for research quality, and it's mostly
*policy*, not architecture:

1. **The `verify` action exists** (§15 action set). When a task holds a
   high-importance, single-sourced claim, the agent's highest-EIG action is
   `verify` — search specifically for *independent* corroboration. Today this
   action doesn't exist; the agent can't decide to corroborate.

2. **The novelty gate stops killing corroborating sources** (§17.2, which I'd
   been violating). The transcript: "low-novelty sources may be skipped
   *unless they provide independent corroboration*." So: a low-novelty source
   from a *new publisher* that *restates a known claim* is **kept**, not
   dropped — it's corroboration. The gate becomes: `drop if low-novelty AND
   same-publisher AND no-new-claim`. This single change is what moves
   corroboration from 4% toward DR-heavy's level.

3. **`required_evidence` per task** includes "≥2 independent publishers" for
   high-importance tasks (§3 above). The completion test literally can't
   pass until corroboration exists, so the agent *must* verify before
   marking done.

4. **The coverage matrix** (§16) has an "Independent corroboration" column.
   A dimension with claims but no corroboration is "Open," not "Complete" —
   the planner will keep routing research there.

These four together are the mechanism. The **policy** pieces (2, 3, 4) need
no new infrastructure — they're fixes to the novelty gate, the task schema,
and the coverage matrix, all of which exist or are straightforward to add.
Only piece (1), the `verify` action, **requires the agent loop from §2 to
exist** — you can't decide to verify if the action sequence is fixed. So the
dependency is honest: corroboration policy is cheap, but it only *fires* once
the control loop is agentic. That's the real reason the loop matters — not
for its own sake, but because it's the only substrate on which `verify` can
run.

---

## 9. Temporal structure (§28 — I'd been interleaving what should be separate)

The transcript's Phase 1–9 is a *sequence*, not a loop body. Some phases are
loop-internal (3 search, 4 extract), some are **distinct passes over
accumulated evidence after the loop** (5 normalize, 6 contradict, 7 scenario,
8 synthesize, 9 audit). I'd been running normalize/contradiction inside the
loop. Resolution:

- **Inside the loop:** search, ingest, extract, per-task memo, claim-graph
  update, coverage-matrix refresh. These are per-action.
- **After the loop, as distinct passes:** global normalization (§9.2 claim
  canonicalization across *all* evidence), contradiction investigation
  (§12, isolated), scenario modeling (§18), synthesis (§21), audits (§23).
  These benefit from seeing the *whole* evidence base at once — running them
  per-iteration produces inconsistent intermediate state.

The claim graph *updates* in the loop (incremental), but the
*contradiction investigation* (adversarial, isolated) runs as a post-loop
pass. Same for global normalization. This matches §28 exactly.

---

## 10. What stays deterministic (don't agent-ify mechanics)

To prevent over-engineering, explicit list of what is **never** an agent
decision:

- URL canonicalization, dedup (SimHash), content hashing
- Search-result ranking (BM25 + authority heuristic)
- Document fetch, format detection, parsing, structural chunking
- Passage retrieval (BM25 + RRF)
- Confidence/uncertainty computation (§19 formula — code)
- Coverage-matrix population (deterministic from evidence + claim graph)
- Budget accounting, anti-loop guards
- Citation reverse-mapping (mechanical, from claim→evidence→source)
- Secret redaction, injection-pattern scanning (§24 — code, fast)

The agent *reads the outputs* of these (coverage matrix, uncertainty scores,
ranked passages) and *decides* over them. It never replaces them.

---

## 11. Resolved design calls (the four I'd been hedging)

These are the calls I tried to punt to you. They're mine to make. Here are
the decisions and the reasoning — push back if you disagree, but the doc
shouldn't ship with open holes.

### 11.1 Planner = orchestrator-loop, NOT a persistent subagent

**Decision:** the planner runs as sequential `complete()` calls in the
orchestrator, re-loading the executive-state snapshot each turn.

**Why not a persistent subagent:** (a) the signed-thinking constraint makes
Anthropic-child resumption fragile; (b) a 30-min research run bloats a single
session's context past the point where early reasoning stays useful; (c) the
on-disk memory **is** the cross-turn reasoning substrate — the planner re-reads
the coverage matrix, uncertainty scores, and task graph each turn, so there's
no amnesia. The *only* thing a persistent session adds is the ability to
"feel" a captured search strategy across turns — but that signal is already
*encoded in the data* (publisher concentration in the coverage matrix, repeated
low-novelty hits, single-sourced claims). The orchestrator-loop reads those
signals explicitly; the persistent session reads them vibes. Explicit wins.

**What "Pi agent more involved" actually means here:** the decisions are
model-driven (the planner is an LLM call, not code), over a rich memory
snapshot, via schema-enforced tools. That's genuine agency. It does not require
one long-lived session.

### 11.2 `verify` aggressiveness = gated by task `required_evidence`

**Decision:** verify is **mandatory** when a task's `required_evidence`
includes "≥2 independent publishers" (the default for priority ≥ 7 tasks) and
a high-importance claim is currently single-sourced. Verify is **optional**
(discretionary, EIG-judged) for lower-priority tasks or claims that are already
contested (contradiction already surfaced → corroboration is lower-value than
resolving the contradiction).

**Cost guard:** verify actions are capped at ~40% of total actions per run.
If a task exhausts its verify budget, it force-completes with the gap
disclosed rather than burning the whole run corroborating one claim. This
bounds the worst case (the "could double the run" fear) while keeping
corroboration the default for what matters.

**Default `required_evidence` by priority:**
- priority ≥ 8: ≥2 independent primary sources + ≥1 quantitative + no unresolved contradiction
- priority 5–7: ≥2 independent publishers + ≥1 primary
- priority < 5: ≥1 credible source

### 11.3 Domain reviewer = opt-in via a `stakes` flag

**Decision:** the domain reviewer (full-draft adversarial critique) is **off
by default**, invoked when the caller passes `stakes: "high"` to `dr_research`,
OR when the spec's `dimensions` match a high-stakes pattern (medical, legal,
financial, safety, regulatory-compliance keywords).

**Why opt-in:** it's the most expensive isolated agent (critiques a
multi-thousand-word draft) and the transcript lists it last. Default-on would
roughly add a full synthesis-pass of cost to every run. But for high-stakes
topics it's the single biggest quality lever — fresh-eyes catch optimism bias
the writer and auditor (who share the evidence base) can't. So: cheap by
default, available when it matters.

### 11.4 Re-decomposition = never block on the user; disclose and continue

**Decision:** if the planner detects spec drift (the evidence is answering a
*different* question than the spec posed), it **does not escalate mid-run**.
It writes the revised spec to the run log, continues researching against the
*revised* spec, and discloses the drift prominently in the report's
Methodology section ("the original objective assumed X; the evidence revealed
Y was the operative question; we researched Y").

**Why not escalate:** escalation breaks the autonomy contract — a research
run is expected to complete, not pause for a meeting. Disclosure is more
honest than silently researching the wrong thing, and continuing under the
revised spec preserves the work already done. If the drift is severe enough
that the revised spec is unrecognizable, the planner marks the run
`spec_divergent` and the report leads with a warning — but it still completes.

---
---

## 12. What "done" looks like for this document

I'll be proud of this design when:

- [x] Every transcript section I'd missed is addressed (§4.1 task node, §5/§6
      continuous planning, §9.2 normalization, §13 hierarchy-as-retrieval,
      §16 coverage matrix, §17.2 corroboration carve-out, §24 control/data
      plane, §26 role isolation, §28 temporal separation).
- [x] The control loop is specified concretely enough to implement, with
      agent-vs-code responsibilities unambiguous.
- [x] The corroboration failure (the actual quality gap vs DR-heavy) has a
      concrete, mechanism-level fix, not a hand-wave.
- [x] The "army vs one agent" tension is resolved with a rule, not a vibe.
- [x] The four design calls I'd been hedging (planner shape, verify
      aggressiveness, domain-review gating, re-decomposition/escalation) are
      resolved in §11 with reasoning, not punted to you.

The code changes fall out of this cleanly. I'm not coding yet — you said we
discuss first — but the design is now complete enough that the discussion is
about *whether you agree with my calls*, not about *filling holes I left*.
