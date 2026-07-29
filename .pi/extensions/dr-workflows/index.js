// .pi/extensions/dr-workflows/index.js
// Workflow extension for pi-deep-research autoresearch.
// Registers drOptimize and drJudge functions.

import { registerWorkflowExtension } from "pi-extensible-workflows";

// ── helpers ─────────────────────────────────────────────────────────────

function parseMetrics(stdout) {
  const metrics = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^METRIC\s+(\w+)=(.+)$/);
    if (m) {
      const key = m[1];
      const val = parseFloat(m[2]);
      metrics[key] = isNaN(val) ? m[2] : val;
    }
  }
  return metrics;
}

function slugify(topic) {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function checkHardGates(metrics) {
  const violations = [];
  const factual = metrics.factual_accuracy ?? 0;
  const citation = metrics.citation_integrity ?? 0;
  if (factual < 3) violations.push(`factual_accuracy=${factual} < 3`);
  if (citation < 3) violations.push(`citation_integrity=${citation} < 3`);
  return { violated: violations.length > 0, violations, factual, citation };
}

// ── the optimizer system prompt (XML-structured per state-of-art 2026) ──

function buildOptimizerPrompt(metrics) {
  return [
    "<system_prompt>",
    "You are the Code Optimization Agent for pi-deep-research.",
    "Your job: improve the research quality of a deep-research engine by modifying its source code.",
    "You operate autonomously — no human review. Your changes must be correct, targeted, and safe.",
    "</system_prompt>",
    "",
    "<project_context>",
    "## What pi-deep-research IS",
    "",
    "pi-deep-research is a deep-research extension for the Pi coding agent, designed to match",
    "ChatGPT Deep Research Heavy quality. It implements a full §14 dynamic research controller:",
    "a model-driven action loop over a dynamic task graph, with coverage-driven task selection,",
    "EIG-weighted action choice, and evidence-based completion tests.",
    "",
    "The `dr_research` tool IS the harness: the orchestrator drives the whole loop programmatically,",
    "and every LLM step is a native tool call (schema-enforced via pi-ai constrained sampling).",
    "",
    "## Architecture",
    "",
    "```",
    "dr_research(topic, { profile: 'standard' })",
    "  │",
    "  ├─ Phase 1  specification          tool call → research spec (objective, dimensions, freshness)",
    "  ├─ Phase 2  decomposition          tool call → task graph (atomic subquestions, priorities)",
    "  │",
    "  ├─ Phase 3-5  DYNAMIC LOOP (controller action loop)",
    "  │     refresh coverage matrix (deterministic)",
    "  │     should_stop? (model decides max-EIG, code applies caps)",
    "  │     select_next_task (model reads coverage matrix, picks highest gap)",
    "  │     choose_action (model picks: search/read/verify/extract/gap_check)",
    "  │     execute_action → evidence → claim graph update",
    "  │     discover_new_tasks (dynamic expansion)",
    "  │",
    "  ├─ Phase 6  claim graph            cluster evidence → claims; relation classification",
    "  ├─ Phase 6b topic syntheses        per-dimension conclusions",
    "  ├─ Phase 7  sectioned synthesis    outline → parallel section drafts → assemble",
    "  └─ Phase 8  audits + repair        citation entailment + 8 static audits",
    "```",
    "",
    "## Source files (ALL in src/) — you MUST read every one before proposing changes",
    "",
    "- src/orchestrator.ts (1058 lines) — MAIN RESEARCH LOOP. The action loop that drives",
    "  the whole pipeline. Contains choose_action dispatch, task management, budget enforcement.",
    "- src/controller.ts (199 lines) — Action executor dispatch + safety guards. Task state",
    "  machine, completion tests, default required_evidence policies.",
    "- src/coverage.ts (114 lines) — Deterministic coverage matrix builder. Computes which",
    "  dimensions have evidence, corroboration, contradictions. Drives task selection.",
    "- src/policy.ts (140 lines) — Task selection + action policy + stop policy. The model's",
    "  decision interface for what to do next.",
    "- src/prompts.ts (500 lines) — Content-generation prompts: spec decomposition, evidence",
    "  extraction, gap checking, synthesis, section drafts, citation entailment. THESE PROMPTS",
    "  DIRECTLY DETERMINE OUTPUT QUALITY.",
    "- src/prompts-policy.ts (126 lines) — Decision prompts: choose_action, gap_check,",
    "  task_selector, stop_policy. The controller's reasoning prompts.",
    "- src/metrics.ts (153 lines) — Research-quality measurement: corroboration fraction,",
    "  citation pass rate, source diversity, publisher concentration. THIS IS HOW QUALITY IS MEASURED.",
    "- src/claimgraph.ts (208 lines) — Claim clustering + relation classification (supports/",
    "  contradicts/qualifies). Entity+value matching for cross-source corroboration.",
    "- src/audits.ts (202 lines) — Citation entailment (reverse map: sentence→claim→evidence→",
    "  source) + 9 audit passes (coverage, claims, citations, contradictions, freshness, etc.).",
    "- src/novel.ts (216 lines) — Dedup + source-family detection. SimHash for near-dup,",
    "  syndication chain detection (Reuters→blog→press-release share a family).",
    "- src/trust.ts (101 lines) — Trust scoring + source quality. Prompt-injection defense.",
    "- src/quality.ts (113 lines) — Quality gate enforcement. Hard gates for factual + citation.",
    "- src/store.ts (374 lines) — Durable research run state. Task/Evidence/Claim/Source types.",
    "  Memory tiers: raw, evidence, memos, claims, audit.",
    "- src/search.ts (199 lines) — Search backends: Exa, ScrapeGraphAI, Tavily, DDG.",
    "- src/ingest.ts (227 lines) — Fetch + parse + trust layer. HTML→readability, PDF→pdf-parse.",
    "- src/passage.ts (150 lines) — BM25 passage selection. Chunks → ranked context window budget.",
    "- src/llm.ts (186 lines) — Tool-calling with constrained sampling + retry. Native tool calls.",
    "- src/config.ts (97 lines) — Backend selection + key resolution.",
    "- src/parallel.ts (40 lines) — Parallel execution utility.",
    "",
    "## Key quality problem being solved",
    "",
    "The #1 weakness is CORROBORATION: only ~10% of claims are backed by ≥2 independent",
    "publishers (target: >50%). ChatGPT DR Heavy achieves near-100%. The root causes are:",
    "1. The novelty gate kills corroborating sources (same story from different publishers)",
    "2. Claim clustering uses text similarity, missing entity+value matches across phrasings",
    "3. The verify action isn't chosen often enough by the controller",
    "4. Source-family detection doesn't catch all syndication chains",
    "",
    "## How metrics map to quality",
    "",
    "- quality_score: composite of all proxy scores (weighted sum)",
    "- factual_accuracy: proxy from corroboration fraction (THE KEY METRIC)",
    "- citation_integrity: proxy from citation pass rate (entailment audit)",
    "- coverage: dimensions covered / total dimensions in spec",
    "- source_quality: publisher diversity (1 - max publisher share)",
    "- contradiction_handling: were contradictions acknowledged (not averaged)",
    "",
    "## Hard constraints (MUST NOT violate)",
    "",
    "1. factual_accuracy proxy must stay ≥ 3/5",
    "2. citation_integrity proxy must stay ≥ 3/5",
    "3. No TypeScript compilation errors (bunx tsc --noEmit must pass)",
    "4. Changes must be backward-compatible with the existing dr_research tool API",
    "</project_context>",
    "",
    "<current_metrics>",
    JSON.stringify(metrics, null, 2),
    "</current_metrics>",
    "",
    "<instructions>",
    "## Your task",
    "",
    "1. READ every file in src/ — use the read tool on each file listed above.",
    "   Do NOT skip any. You need full context before proposing a change.",
    "   Track what you've read in your reasoning.",
    "",
    "2. ANALYZE the weakest metric. The current metrics are shown above.",
    "   Identify the ROOT CAUSE in the code — not a symptom.",
    "   Trace the data flow: where does this metric get computed? What feeds it?",
    "",
    "3. PROPOSE a targeted fix. One change at a time. Small, surgical diffs.",
    "   Prefer changing prompts (src/prompts.ts, src/prompts-policy.ts) over logic changes,",
    "   because prompts directly control what the model does at each stage.",
    "   If the issue is algorithmic (e.g., corroboration detection), fix the logic.",
    "",
    "4. GENERATE a unified diff. The diff must apply cleanly with `git apply`.",
    "   Include enough context lines for git to find the insertion point.",
    "",
    "## What NOT to do",
    "",
    "- Do NOT add new dependencies",
    "- Do NOT refactor working code for style",
    "- Do NOT change the dr_research tool signature or return type",
    "- Do NOT break TypeScript compilation",
    "- Do NOT add comments explaining your change (the diff speaks for itself)",
    "</instructions>",
    "",
    "<output_format>",
    "Return a JSON object via the output schema:",
    "- diff: a unified diff (git diff format) that applies cleanly",
    "- rationale: ONE sentence explaining the root cause you identified and how your patch addresses it",
    "- files_read: array of all src/*.ts files you actually read (for verification)",
    "</output_format>",
  ].join("\n");
}

// ── drOptimize: one optimization iteration ──────────────────────────────

const drOptimize = {
  description: "Run one autonomous optimization iteration for pi-deep-research. Uses gpt-5.6-sol (max thinking) to read the entire codebase, identify the root cause of the weakest metric, and generate a targeted patch.",
  input: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Research topic to optimize against",
      },
      max_attempts: {
        type: "integer",
        description: "Max patch attempts if first fails hard gate",
      },
    },
    required: ["topic"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      old_score: { type: "number" },
      new_score: { type: "number" },
      delta: { type: "number" },
      kept: { type: "boolean" },
      patch_summary: { type: "string" },
      files_read: { type: "array", items: { type: "string" } },
      hard_gate_status: { type: "object" },
    },
    required: ["old_score", "new_score", "kept"],
    additionalProperties: false,
  },
  async run(input, context) {
    const topic = String(input.topic);
    const maxAttempts = input.max_attempts ?? 3;

    // ── Phase 1: BASELINE MEASURE ────────────────────────────────────
    context.phase("baseline-measure");

    const baselineRes = await context.shell(
      `TOPIC="${topic}" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts`,
      { timeoutMs: 600000 },
    );

    const baselineMetrics = parseMetrics(baselineRes.stdout);
    const oldScore = baselineMetrics.quality_score ?? 0;
    context.log(`Baseline: quality_score=${oldScore.toFixed(4)} corroboration=${baselineMetrics.corroboration ?? 0}`);

    // ── Phase 2-N: PATCH ATTEMPTS ────────────────────────────────────
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      context.phase(`patch-attempt-${attempt}`);
      context.log(`Launching optimizer (gpt-5.6-sol, max thinking)...`);

      const patchResult = await context.agent(
        buildOptimizerPrompt(baselineMetrics),
        {
          label: `optimizer-attempt-${attempt}`,
          model: "openai-codex/gpt-5.6-sol",
          thinking: "max",
          outputSchema: {
            type: "object",
            properties: {
              diff: { type: "string", description: "Unified diff (git diff format)" },
              rationale: { type: "string", description: "Root cause + how patch addresses it" },
              files_read: { type: "array", items: { type: "string" } },
            },
            required: ["diff", "rationale", "files_read"],
            additionalProperties: false,
          },
          timeoutMs: 600000,
        },
      );

      const patch = patchResult?.diff ?? "";
      const rationale = patchResult?.rationale ?? "";
      const filesRead = patchResult?.files_read ?? [];

      context.log(`Optimizer read ${filesRead.length} files. Rationale: ${rationale}`);

      if (!patch.trim()) {
        context.log(`Attempt ${attempt}: no patch generated`);
        continue;
      }

      // ── Phase 3: TEST PATCH ──────────────────────────────────────
      context.phase(`test-attempt-${attempt}`);

      // Write patch to temp file
      await context.shell(
        `cat > __optimize.patch << 'PATCH_EOF'\n${patch}\nPATCH_EOF`,
        { timeoutMs: 10000 },
      );

      const applyRes = await context.shell(
        `git apply --check __optimize.patch 2>&1 && git apply __optimize.patch 2>&1`,
        { timeoutMs: 10000 },
      );

      if (applyRes.exitCode !== 0) {
        context.log(`Patch apply failed: ${applyRes.stderr || applyRes.stdout}`);
        await context.shell(`rm -f __optimize.patch`, { timeoutMs: 5000 });
        continue;
      }

      // TypeScript check before running expensive measure
      const tscRes = await context.shell(`bunx tsc --noEmit 2>&1`, { timeoutMs: 60000 });
      if (tscRes.exitCode !== 0) {
        context.log(`TypeScript compilation failed after patch. Reverting.`);
        context.log(tscRes.stderr.slice(0, 500));
        await context.shell(`git apply -R __optimize.patch`, { timeoutMs: 10000 });
        await context.shell(`rm -f __optimize.patch`, { timeoutMs: 5000 });
        continue;
      }
      context.log(`TypeScript OK. Running measure...`);

      // Run measure with patch applied
      const measureRes = await context.shell(
        `TOPIC="${topic}" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts`,
        { timeoutMs: 600000 },
      );

      const newMetrics = parseMetrics(measureRes.stdout);
      const newScore = newMetrics.quality_score ?? 0;
      const gateStatus = checkHardGates(newMetrics);
      const delta = newScore - oldScore;

      context.log(
        `Attempt ${attempt}: score ${oldScore.toFixed(4)} → ${newScore.toFixed(4)} ` +
        `(delta=${delta >= 0 ? "+" : ""}${delta.toFixed(4)}, ` +
        `corroboration=${(newMetrics.corroboration ?? 0).toFixed(4)}, ` +
        `gates=${gateStatus.violated ? "FAIL" : "OK"})`,
      );

      // Revert the patch (will re-apply if we decide to keep)
      await context.shell(`git apply -R __optimize.patch`, { timeoutMs: 10000 });

      // ── Phase 4: AUTONOMOUS DECISION ─────────────────────────────
      const improved = delta > 0.001;
      const gatesOk = !gateStatus.violated;

      if (improved && gatesOk) {
        // KEEP: re-apply the patch
        context.phase(`merge`);
        await context.shell(`git apply __optimize.patch`, { timeoutMs: 10000 });
        await context.shell(`rm -f __optimize.patch`, { timeoutMs: 5000 });
        context.log(`PATCH KEPT — score improved by ${delta.toFixed(4)}`);

        return {
          old_score: oldScore,
          new_score: newScore,
          delta,
          kept: true,
          patch_summary: rationale,
          files_read: filesRead,
          hard_gate_status: gateStatus,
        };
      }

      if (!gatesOk && attempt < maxAttempts) {
        context.log(`Hard gate violated: ${gateStatus.violations.join(", ")}. Retrying...`);
        await context.shell(`rm -f __optimize.patch`, { timeoutMs: 5000 });
        continue;
      }

      // DISCARD
      await context.shell(`rm -f __optimize.patch`, { timeoutMs: 5000 });
      return {
        old_score: oldScore,
        new_score: newScore,
        delta,
        kept: false,
        patch_summary: gatesOk ? rationale : `Hard gate violated: ${gateStatus.violations.join(", ")}`,
        files_read: filesRead,
        hard_gate_status: gateStatus,
      };
    }

    return {
      old_score: oldScore,
      new_score: oldScore,
      delta: 0,
      kept: false,
      patch_summary: `All ${maxAttempts} attempts failed`,
      hard_gate_status: checkHardGates(baselineMetrics),
    };
  },
};

// ── drJudge: full LLM-judge quality gate ────────────────────────────────

const JUROR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      minItems: 9,
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          score_a: { type: "integer", minimum: 1, maximum: 5 },
          score_b: { type: "integer", minimum: 1, maximum: 5 },
          justification: { type: "string" },
        },
        required: ["criterion", "score_a", "score_b", "justification"],
        additionalProperties: false,
      },
    },
    composite_a: { type: "number" },
    composite_b: { type: "number" },
    preference: { type: "string", enum: ["A", "B", "tie"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    key_strengths_a: { type: "array", items: { type: "string" } },
    key_weaknesses_a: { type: "array", items: { type: "string" } },
    key_strengths_b: { type: "array", items: { type: "string" } },
    key_weaknesses_b: { type: "array", items: { type: "string" } },
  },
  required: ["scores", "preference", "confidence"],
  additionalProperties: false,
};

function jurorPrompt(topic, reportA, reportB) {
  return `You are an expert evaluator scoring two research reports on the same topic.
You do NOT know which system produced which report. Score each on the rubric below.

IMPORTANT: Score based on EVIDENCE, not eloquence. A well-written but shallow report must NOT score higher than a less polished but factually rigorous one.

TOPIC: "${topic}"

### REPORT A
${reportA}

### REPORT B
${reportB}

Score each report (A and B separately) on each criterion, 1-5 scale.
Use the FULL range — do not default to 3 for everything:
- 5 = exceptional: best-in-class, no issues, exceeds expectations
- 4 = strong: minor issues only, clearly above average
- 3 = adequate: acceptable but unremarkable, some gaps
- 2 = weak: significant problems, hard to rely on
- 1 = unacceptable: fundamental failures, misleading or wrong

RUBRIC (9 criteria, weighted):
1. factual_accuracy (20%): Are claims correct? Numbers properly represented? Caveats preserved?
2. citation_integrity (20%): Do cited sources actually support adjacent claims? Distinguish specific claims (must cite) from common knowledge (uncited OK).
3. source_quality (15%): Primary sources? Independent? Diverse publishers? Penalize citation spam.
4. coverage (15%): Does it fully answer the research question?
5. contradiction_handling (10%): Does it surface disagreements rather than averaging?
6. analytical_depth (5%): Does it synthesize novel insights beyond summarizing sources?
7. timeliness (5%): Is the information current as of the research date?
8. structure_actionability (5%): Well-organized? Can a decision-maker act on it?
9. conciseness (5%): Is every sentence earning its place? Penalize filler/repetition.

For each criterion: Score A (1-5), Score B (1-5), one-sentence justification.
Then: composite_A, composite_B, preference, confidence.

Return ONLY the JSON via the output schema.`;
}

const drJudge = {
  description: "Run the full LLM-judge quality gate on one topic.",
  input: {
    type: "object",
    properties: {
      topic: { type: "string" },
      profile: { type: "string", default: "standard" },
      use_cached_reference: { type: "boolean", default: true },
    },
    required: ["topic"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      verdict: { type: "object" },
      per_criterion: { type: "array" },
      passed: { type: "boolean" },
      bias_report: { type: "array" },
    },
    additionalProperties: false,
  },
  async run(input, context) {
    const topic = String(input.topic);
    const profile = input.profile ?? "standard";
    const useCached = input.use_cached_reference ?? true;
    const slug = slugify(topic);

    // ── Phase 1: CANDIDATE ──────────────────────────────────────────
    context.phase("candidate");
    context.log(`Running candidate (dr_research) on: ${topic.slice(0, 60)}...`);

    const candidateRes = await context.shell(
      `TOPIC="${topic}" MODEL="zai/glm-4.5-air" bun test/suites/smoke.ts`,
      { timeoutMs: 600000 },
    );

    const reportReadRes = await context.shell(
      `cat test/results/${slug}/ours_report.md`,
      { timeoutMs: 5000 },
    );
    const oursReport = reportReadRes.stdout;

    if (!oursReport || oursReport.length < 100) {
      throw new Error(`Candidate report missing at test/results/${slug}/ours_report.md`);
    }

    context.log(`Candidate report: ${oursReport.split(/\s+/).length} words`);

    // ── Phase 2: REFERENCE ──────────────────────────────────────────
    context.phase("reference");

    let drhReport = "";
    const cacheCheckRes = await context.shell(
      `test -f test/results/${slug}/drh_report.md && echo "EXISTS" || echo "MISSING"`,
      { timeoutMs: 5000 },
    );

    if (useCached && cacheCheckRes.stdout.trim() === "EXISTS") {
      const refReadRes = await context.shell(
        `cat test/results/${slug}/drh_report.md`,
        { timeoutMs: 5000 },
      );
      drhReport = refReadRes.stdout;
      context.log(`Using cached DRH reference: ${drhReport.split(/\s+/).length} words`);
    } else {
      context.log("Generating DRH reference via gpt_chat...");
      const refResult = await context.agent(
        `Call the gpt_chat tool with these exact arguments:\n` +
        `- prompt: "Research thoroughly: ${topic}"\n` +
        `- chat_type: "deep_research_heavy"\n\n` +
        `Wait for the full research report. Return the complete report text in the "report" field.`,
        {
          label: "drh-reference",
          tools: ["gpt_chat"],
          timeoutMs: 1800000,
          outputSchema: {
            type: "object",
            properties: { report: { type: "string" } },
            required: ["report"],
            additionalProperties: false,
          },
        },
      );
      drhReport = refResult?.report ?? "";

      await context.shell(
        `mkdir -p test/results/${slug} && cat > test/results/${slug}/drh_report.md << 'REF_EOF'\n${drhReport}\nREF_EOF`,
        { timeoutMs: 10000 },
      );
      await context.shell(
        `echo '{"timestamp":"'$(date -Iseconds)'"}' > test/results/${slug}/drh_meta.json`,
        { timeoutMs: 5000 },
      );
      context.log(`Saved DRH reference: ${drhReport.split(/\s+/).length} words`);
    }

    // ── Phase 3: BLIND JUROR ×2 (parallel, swapped) ─────────────────
    context.phase("juror");

    const oursFirst = Math.random() < 0.5;
    const reportA = oursFirst ? oursReport : drhReport;
    const reportB = oursFirst ? drhReport : oursReport;
    const labels = {
      run1: { A: oursFirst ? "ours" : "drh", B: oursFirst ? "drh" : "ours" },
      run2: { A: oursFirst ? "drh" : "ours", B: oursFirst ? "ours" : "drh" },
    };

    context.log("Running blind juror ×2 (parallel, swapped)...");

    const jurorResults = await context.parallel("juror", {
      run1: () =>
        context.agent(jurorPrompt(topic, reportA, reportB), {
          label: "juror-run-1",
          model: "openai-codex/gpt-5.6-sol",
          thinking: "max",
          outputSchema: JUROR_OUTPUT_SCHEMA,
          timeoutMs: 300000,
        }),
      run2: () =>
        context.agent(jurorPrompt(topic, reportB, reportA), {
          label: "juror-run-2",
          model: "openai-codex/gpt-5.6-sol",
          thinking: "max",
          outputSchema: JUROR_OUTPUT_SCHEMA,
          timeoutMs: 300000,
        }),
    });

    // ── Phase 4: AGGREGATE ──────────────────────────────────────────
    context.phase("aggregate");

    await context.shell(
      `cat > test/results/${slug}/juror-run1.json << 'J1_EOF'\n${JSON.stringify(jurorResults.run1, null, 2)}\nJ1_EOF`,
      { timeoutMs: 5000 },
    );
    await context.shell(
      `cat > test/results/${slug}/juror-run2.json << 'J2_EOF'\n${JSON.stringify(jurorResults.run2, null, 2)}\nJ2_EOF`,
      { timeoutMs: 5000 },
    );
    await context.shell(
      `cat > test/results/${slug}/labels.json << 'L_EOF'\n${JSON.stringify(labels, null, 2)}\nL_EOF`,
      { timeoutMs: 5000 },
    );

    const aggregateRes = await context.shell(
      `bun test/suites/judge.ts --aggregate ${slug}`,
      { timeoutMs: 60000 },
    );

    const passed = aggregateRes.exitCode === 0;
    const verdictMetrics = parseMetrics(aggregateRes.stdout);

    return {
      verdict: { ...verdictMetrics, labels },
      per_criterion: jurorResults.run1?.scores ?? [],
      passed,
      bias_report: [],
    };
  },
};

// ── register ───────────────────────────────────────────────────────────

const drWorkflowExtension = {
  version: "1.0.0",
  headline: "pi-deep-research autoresearch",
  description: "Autonomous optimization and judging workflows for pi-deep-research.",
  functions: {
    drOptimize,
    drJudge,
  },
};

export default function extension() {
  registerWorkflowExtension(drWorkflowExtension);
}
