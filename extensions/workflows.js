// extensions/workflows.js — workflow extension for pi-deep-research.
// Registers drOptimize and drJudge as pi-extensible-workflows functions.
// ESM (project has "type": "module").

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
  if (factual < 3) violations.push("factual_accuracy=" + factual + " < 3");
  if (citation < 3) violations.push("citation_integrity=" + citation + " < 3");
  return { violated: violations.length > 0, violations, factual, citation };
}

// ── optimizer prompt (XML-structured per state-of-art 2026) ─────────────

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
    "  ├─ Phase 1  specification          tool call → research spec",
    "  ├─ Phase 2  decomposition          tool call → task graph",
    "  ├─ Phase 3-5  DYNAMIC LOOP (controller action loop)",
    "  │     refresh coverage matrix → should_stop? → select_next_task → choose_action → execute",
    "  ├─ Phase 6  claim graph            cluster evidence → claims; relation classification",
    "  ├─ Phase 7  sectioned synthesis    outline → parallel section drafts → assemble",
    "  └─ Phase 8  audits + repair        citation entailment + 8 static audits",
    "```",
    "",
    "## Source files (ALL in src/) — you MUST read every one before proposing changes",
    "",
    "- src/orchestrator.ts (1058 lines) — MAIN RESEARCH LOOP. Action loop, choose_action dispatch.",
    "- src/controller.ts (199 lines) — Action executor dispatch + safety guards. Task state machine.",
    "- src/coverage.ts (114 lines) — Deterministic coverage matrix builder. Drives task selection.",
    "- src/policy.ts (140 lines) — Task selection + action policy + stop policy.",
    "- src/prompts.ts (500 lines) — Content-generation prompts. THESE DIRECTLY DETERMINE OUTPUT QUALITY.",
    "- src/prompts-policy.ts (126 lines) — Decision prompts: choose_action, gap_check, stop_policy.",
    "- src/metrics.ts (153 lines) — Research-quality measurement. THIS IS HOW QUALITY IS MEASURED.",
    "- src/claimgraph.ts (208 lines) — Claim clustering + entity+value corroboration matching.",
    "- src/audits.ts (202 lines) — Citation entailment + 9 audit passes.",
    "- src/novel.ts (216 lines) — Dedup + source-family detection. SimHash + syndication chains.",
    "- src/trust.ts (101 lines) — Trust scoring + source quality. Prompt-injection defense.",
    "- src/quality.ts (113 lines) — Quality gate enforcement. Hard gates.",
    "- src/store.ts (374 lines) — Durable research run state. Memory tiers.",
    "- src/search.ts (199 lines) — Search backends: Exa, ScrapeGraphAI, Tavily, DDG.",
    "- src/ingest.ts (227 lines) — Fetch + parse + trust layer.",
    "- src/passage.ts (150 lines) — BM25 passage selection.",
    "- src/llm.ts (186 lines) — Tool-calling with constrained sampling + retry.",
    "- src/config.ts (97 lines) — Backend selection + key resolution.",
    "- src/parallel.ts (40 lines) — Parallel execution utility.",
    "",
    "## Key quality problem",
    "",
    "The #1 weakness is CORROBORATION: only ~10% of claims are backed by ≥2 independent",
    "publishers (target: >50%). Root causes: novelty gate kills corroborating sources,",
    "claim clustering misses entity+value matches, verify action underused.",
    "",
    "## How metrics map to quality",
    "",
    "- factual_accuracy: proxy from corroboration fraction (THE KEY METRIC)",
    "- citation_integrity: proxy from citation pass rate (entailment audit)",
    "- coverage: dimensions covered / total",
    "- source_quality: publisher diversity",
    "- contradiction_handling: were contradictions acknowledged",
    "",
    "## Hard constraints (MUST NOT violate)",
    "1. factual_accuracy ≥ 3/5",
    "2. citation_integrity ≥ 3/5",
    "3. No TypeScript compilation errors",
    "4. Backward-compatible with dr_research tool API",
    "</project_context>",
    "",
    "<current_metrics>",
    JSON.stringify(metrics, null, 2),
    "</current_metrics>",
    "",
    "<instructions>",
    "1. READ every file in src/ — use the read tool on each. Do NOT skip any.",
    "2. ANALYZE the weakest metric. Identify the ROOT CAUSE in the code.",
    "3. PROPOSE a targeted fix. One change. Small, surgical diff.",
    "4. GENERATE a unified diff that applies cleanly with git apply.",
    "",
    "Do NOT: add dependencies, refactor for style, change dr_research API, break tsc.",
    "</instructions>",
    "",
    "<output_format>",
    "Return JSON: diff (unified diff), rationale (one sentence), files_read (array of paths read).",
    "</output_format>",
  ].join("\n");
}

// ── drOptimize ──────────────────────────────────────────────────────────

const drOptimize = {
  description: "Run one autonomous optimization iteration for pi-deep-research.",
  input: {
    type: "object",
    properties: {
      topic: { type: "string" },
      max_attempts: { type: "integer" },
    },
    required: ["topic"],
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
  },
  async run(input, context) {
    context.log("DEBUG drOptimize input: " + JSON.stringify(input));
    const topic = String(input.topic);
    const maxAttempts = input.max_attempts ?? 3;

    // Phase 1: BASELINE MEASURE
    context.phase("baseline-measure");
    const baselineRes = await context.shell(
      'TOPIC="' + topic + '" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts',
      { timeoutMs: 600000 }
    );
    const baselineMetrics = parseMetrics(baselineRes.stdout);
    const oldScore = baselineMetrics.quality_score ?? 0;
    context.log("Baseline: quality_score=" + oldScore.toFixed(4) + " corroboration=" + (baselineMetrics.corroboration ?? 0));

    // Phase 2-N: PATCH ATTEMPTS
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      context.phase("patch-attempt-" + attempt);
      context.log("Launching optimizer (gpt-5.6-sol, max thinking)...");

      const patchResult = await context.agent(buildOptimizerPrompt(baselineMetrics), {
        label: "optimizer-attempt-" + attempt,
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
      });

      const patch = patchResult?.diff ?? "";
      const rationale = patchResult?.rationale ?? "";
      const filesRead = patchResult?.files_read ?? [];
      context.log("Optimizer read " + filesRead.length + " files. Rationale: " + rationale);

      if (!patch.trim()) {
        context.log("Attempt " + attempt + ": no patch generated");
        continue;
      }

      // Phase 3: TEST PATCH
      context.phase("test-attempt-" + attempt);
      await context.shell("cat > __optimize.patch << 'PATCH_EOF'\n" + patch + "\nPATCH_EOF", { timeoutMs: 10000 });

      const applyRes = await context.shell(
        "git apply --check __optimize.patch 2>&1 && git apply __optimize.patch 2>&1",
        { timeoutMs: 10000 }
      );
      if (applyRes.exitCode !== 0) {
        context.log("Patch apply failed: " + (applyRes.stderr || applyRes.stdout));
        await context.shell("rm -f __optimize.patch", { timeoutMs: 5000 });
        continue;
      }

      // TypeScript check before expensive measure
      const tscRes = await context.shell("bunx tsc --noEmit 2>&1", { timeoutMs: 60000 });
      if (tscRes.exitCode !== 0) {
        context.log("TypeScript compilation failed. Reverting.");
        context.log(tscRes.stderr.slice(0, 500));
        await context.shell("git apply -R __optimize.patch", { timeoutMs: 10000 });
        await context.shell("rm -f __optimize.patch", { timeoutMs: 5000 });
        continue;
      }
      context.log("TypeScript OK. Running measure...");

      // Run measure with patch applied
      const measureRes = await context.shell(
        'TOPIC="' + topic + '" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts',
        { timeoutMs: 600000 }
      );
      const newMetrics = parseMetrics(measureRes.stdout);
      const newScore = newMetrics.quality_score ?? 0;
      const gateStatus = checkHardGates(newMetrics);
      const delta = newScore - oldScore;

      context.log(
        "Attempt " + attempt + ": score " + oldScore.toFixed(4) + " → " + newScore.toFixed(4) +
        " (delta=" + (delta >= 0 ? "+" : "") + delta.toFixed(4) + ", gates=" + (gateStatus.violated ? "FAIL" : "OK") + ")"
      );

      // Revert (re-apply if we decide to keep)
      await context.shell("git apply -R __optimize.patch", { timeoutMs: 10000 });

      // Phase 4: AUTONOMOUS DECISION
      const improved = delta > 0.001;
      const gatesOk = !gateStatus.violated;

      if (improved && gatesOk) {
        context.phase("merge");
        await context.shell("git apply __optimize.patch", { timeoutMs: 10000 });
        await context.shell("rm -f __optimize.patch", { timeoutMs: 5000 });
        context.log("PATCH KEPT — improved by " + delta.toFixed(4));
        return { old_score: oldScore, new_score: newScore, delta, kept: true, patch_summary: rationale, files_read: filesRead, hard_gate_status: gateStatus };
      }

      if (!gatesOk && attempt < maxAttempts) {
        context.log("Hard gate violated: " + gateStatus.violations.join(", ") + ". Retrying...");
        await context.shell("rm -f __optimize.patch", { timeoutMs: 5000 });
        continue;
      }

      await context.shell("rm -f __optimize.patch", { timeoutMs: 5000 });
      return { old_score: oldScore, new_score: newScore, delta, kept: false, patch_summary: gatesOk ? rationale : "Hard gate: " + gateStatus.violations.join(", "), files_read: filesRead, hard_gate_status: gateStatus };
    }

    return { old_score: oldScore, new_score: oldScore, delta: 0, kept: false, patch_summary: "All " + maxAttempts + " attempts failed", hard_gate_status: checkHardGates(baselineMetrics) };
  },
};

// ── drJudge ─────────────────────────────────────────────────────────────

const JUROR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scores: { type: "array", minItems: 9, items: { type: "object", properties: {
      criterion: { type: "string" }, score_a: { type: "integer", minimum: 1, maximum: 5 },
      score_b: { type: "integer", minimum: 1, maximum: 5 }, justification: { type: "string" },
    }, required: ["criterion", "score_a", "score_b", "justification"], additionalProperties: false } },
    composite_a: { type: "number" }, composite_b: { type: "number" },
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
  return 'You are an expert evaluator scoring two research reports on the same topic.\n' +
    'You do NOT know which system produced which report. Score each on the rubric below.\n\n' +
    'IMPORTANT: Score based on EVIDENCE, not eloquence.\n\n' +
    'TOPIC: "' + topic + '"\n\n' +
    '### REPORT A\n' + reportA + '\n\n' +
    '### REPORT B\n' + reportB + '\n\n' +
    'Score each (A and B) on each criterion, 1-5. Use the FULL range.\n' +
    '- 5 = exceptional, 4 = strong, 3 = adequate, 2 = weak, 1 = unacceptable\n\n' +
    'RUBRIC (9 criteria, weighted):\n' +
    '1. factual_accuracy (20%): Are claims correct?\n' +
    '2. citation_integrity (20%): Do cited sources support adjacent claims?\n' +
    '3. source_quality (15%): Primary sources? Independent? Penalize citation spam.\n' +
    '4. coverage (15%): Does it fully answer the question?\n' +
    '5. contradiction_handling (10%): Does it surface disagreements?\n' +
    '6. analytical_depth (5%): Novel insights beyond summarizing?\n' +
    '7. timeliness (5%): Current as of research date?\n' +
    '8. structure_actionability (5%): Well-organized? Actionable?\n' +
    '9. conciseness (5%): Every sentence earning its place?\n\n' +
    'For each: Score A, Score B, one-sentence justification.\n' +
    'Then: composite_A, composite_B, preference, confidence.\n\n' +
    'Return ONLY the JSON via the output schema.';
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
      verdict: { type: "object" }, per_criterion: { type: "array" },
      passed: { type: "boolean" }, bias_report: { type: "array" },
    },
    additionalProperties: false,
  },
  async run(input, context) {
    const topic = String(input.topic);
    const useCached = input.use_cached_reference ?? true;
    const slug = slugify(topic);

    // Phase 1: CANDIDATE
    context.phase("candidate");
    context.log("Running candidate (dr_research)...");
    await context.shell('TOPIC="' + topic + '" MODEL="zai/glm-4.5-air" bun test/suites/smoke.ts', { timeoutMs: 600000 });
    const reportRes = await context.shell("cat test/results/" + slug + "/ours_report.md", { timeoutMs: 5000 });
    const oursReport = reportRes.stdout;
    if (!oursReport || oursReport.length < 100) throw new Error("Candidate report missing");
    context.log("Candidate: " + oursReport.split(/\s+/).length + " words");

    // Phase 2: REFERENCE
    context.phase("reference");
    let drhReport = "";
    const cacheRes = await context.shell('test -f test/results/' + slug + '/drh_report.md && echo EXISTS || echo MISSING', { timeoutMs: 5000 });
    if (useCached && cacheRes.stdout.trim() === "EXISTS") {
      drhReport = (await context.shell("cat test/results/" + slug + "/drh_report.md", { timeoutMs: 5000 })).stdout;
      context.log("Cached DRH: " + drhReport.split(/\s+/).length + " words");
    } else {
      context.log("Generating DRH reference via gpt_chat...");
      const refResult = await context.agent(
        'Call gpt_chat with chat_type: "deep_research_heavy" to research: "' + topic + '". Return the full report text.',
        { label: "drh-reference", tools: ["gpt_chat"], timeoutMs: 1800000,
          outputSchema: { type: "object", properties: { report: { type: "string" } }, required: ["report"], additionalProperties: false } }
      );
      drhReport = refResult?.report ?? "";
      await context.shell("mkdir -p test/results/" + slug + " && cat > test/results/" + slug + "/drh_report.md << 'REF_EOF'\n" + drhReport + "\nREF_EOF", { timeoutMs: 10000 });
      context.log("Saved DRH: " + drhReport.split(/\s+/).length + " words");
    }

    // Phase 3: BLIND JUROR ×2 (parallel, swapped)
    context.phase("juror");
    const oursFirst = Math.random() < 0.5;
    const reportA = oursFirst ? oursReport : drhReport;
    const reportB = oursFirst ? drhReport : oursReport;
    const labels = {
      run1: { A: oursFirst ? "ours" : "drh", B: oursFirst ? "drh" : "ours" },
      run2: { A: oursFirst ? "drh" : "ours", B: oursFirst ? "ours" : "drh" },
    };
    context.log("Running blind juror ×2 (parallel)...");

    const jurorResults = await context.parallel("juror", {
      run1: () => context.agent(jurorPrompt(topic, reportA, reportB), {
        label: "juror-run-1", model: "openai-codex/gpt-5.6-sol", thinking: "max",
        outputSchema: JUROR_OUTPUT_SCHEMA, timeoutMs: 300000,
      }),
      run2: () => context.agent(jurorPrompt(topic, reportB, reportA), {
        label: "juror-run-2", model: "openai-codex/gpt-5.6-sol", thinking: "max",
        outputSchema: JUROR_OUTPUT_SCHEMA, timeoutMs: 300000,
      }),
    });

    // Phase 4: AGGREGATE
    context.phase("aggregate");
    await context.shell("cat > test/results/" + slug + "/juror-run1.json << 'J1_EOF'\n" + JSON.stringify(jurorResults.run1, null, 2) + "\nJ1_EOF", { timeoutMs: 5000 });
    await context.shell("cat > test/results/" + slug + "/juror-run2.json << 'J2_EOF'\n" + JSON.stringify(jurorResults.run2, null, 2) + "\nJ2_EOF", { timeoutMs: 5000 });
    await context.shell("cat > test/results/" + slug + "/labels.json << 'L_EOF'\n" + JSON.stringify(labels, null, 2) + "\nL_EOF", { timeoutMs: 5000 });

    const aggregateRes = await context.shell("bun test/suites/judge.ts --aggregate " + slug, { timeoutMs: 60000 });
    const verdictMetrics = parseMetrics(aggregateRes.stdout);
    return { verdict: { ...verdictMetrics, labels }, per_criterion: jurorResults.run1?.scores ?? [], passed: aggregateRes.exitCode === 0, bias_report: [] };
  },
};

// ── register ───────────────────────────────────────────────────────────

const drWorkflowExtension = {
  version: "1.0.0",
  headline: "pi-deep-research autoresearch",
  description: "Autonomous optimization and judging workflows for pi-deep-research.",
  functions: {
    drPing: {
      description: "Test function.",
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "string" },
      run(input) {
        return "Hello, " + String(input.name) + "!";
      },
    },
    drOptimize,
    drJudge,
  },
};

export default function extension() {
  registerWorkflowExtension(drWorkflowExtension);
}
