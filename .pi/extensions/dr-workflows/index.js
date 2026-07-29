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

// ── drOptimize: one optimization iteration ──────────────────────────────

const drOptimize = {
  description: "Run one autonomous optimization iteration for pi-deep-research.",
  input: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Research topic to optimize against",
      },
      target_files: {
        type: "array",
        items: { type: "string" },
        description: "Files the optimizer agent may modify",
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
      hard_gate_status: { type: "object" },
    },
    required: ["old_score", "new_score", "kept"],
    additionalProperties: false,
  },
  async run(input, context) {
    const topic = String(input.topic);
    const targetFiles = input.target_files ?? [
      "src/prompts.ts",
      "src/prompts-policy.ts",
      "src/orchestrator.ts",
    ];
    const maxAttempts = input.max_attempts ?? 3;

    context.phase("baseline-measure");

    // ── Phase 1: BASELINE MEASURE ────────────────────────────────────
    const baselineRes = await context.shell(
      `TOPIC="${topic}" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts`,
      { timeoutMs: 600000 },
    );

    if (baselineRes.exitCode !== null && baselineRes.exitCode !== 0 && !baselineRes.stdout.includes("METRIC")) {
      throw new Error(`Baseline measure failed: ${baselineRes.stderr || baselineRes.stdout}`);
    }

    const baselineMetrics = parseMetrics(baselineRes.stdout);
    const oldScore = baselineMetrics.quality_score ?? 0;
    context.log(`Baseline: quality_score=${oldScore.toFixed(4)}`);

    // ── Phase 2-N: PATCH ATTEMPTS ────────────────────────────────────
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      context.phase(`patch-attempt-${attempt}`);

      // Generate patch
      const metricsStr = JSON.stringify(baselineMetrics, null, 2);
      const patchResult = await context.agent(
        context.prompt(
          `You are optimizing pi-deep-research.\n\n` +
          `Current metrics:\n{metrics}\n\n` +
          `You may modify these files: {files}\n\n` +
          `Focus on the weakest criterion. Generate a small, targeted patch.\n` +
          `Return ONLY the JSON via the output schema.`,
          { metrics: metricsStr, files: targetFiles.join(", ") },
        ),
        {
          label: `optimizer-attempt-${attempt}`,
          role: "optimizer",
          outputSchema: {
            type: "object",
            properties: {
              diff: { type: "string", description: "Unified diff" },
              rationale: { type: "string", description: "One-sentence rationale" },
            },
            required: ["diff", "rationale"],
            additionalProperties: false,
          },
        },
      );

      const patch = patchResult?.diff ?? "";
      const rationale = patchResult?.rationale ?? "";

      if (!patch.trim()) {
        context.log(`Attempt ${attempt}: no patch generated (${rationale})`);
        continue;
      }

      // ── Phase 3: IN-PLACE TEST (worktree when clean, in-place when dirty) ─
      context.phase(`test-attempt-${attempt}`);

      // Check if we can use a worktree (requires committed state)
      const gitStatusRes = await context.shell(
        `git diff --quiet HEAD 2>/dev/null && echo "CLEAN" || echo "DIRTY"`,
        { timeoutMs: 5000 },
      );
      const gitClean = gitStatusRes.stdout.trim() === "CLEAN";

      let newMetrics;

      if (gitClean) {
        // Worktree path: isolated branch, safe to discard
        newMetrics = await context.withWorktree(`optimize-attempt`, async ({ path: wtPath }) => {
          const patchFile = `${wtPath}/__optimize.patch`;
          await context.shell(
            `cat > "${patchFile}" << 'PATCH_EOF'\n${patch}\nPATCH_EOF`,
            { timeoutMs: 10000 },
          );
          const applyRes = await context.shell(
            `cd "${wtPath}" && git apply --check "${patchFile}" 2>&1 && git apply "${patchFile}" 2>&1`,
            { timeoutMs: 10000 },
          );
          if (applyRes.exitCode !== 0) {
            context.log(`Patch apply failed: ${applyRes.stderr || applyRes.stdout}`);
            return null;
          }
          const measureRes = await context.shell(
            `cd "${wtPath}" && TOPIC="${topic}" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts`,
            { timeoutMs: 600000 },
          );
          return parseMetrics(measureRes.stdout);
        });
      } else {
        // In-place path: stash → apply → measure → decide → revert/keep
        context.log(`Git dirty — using in-place patch test`);

        const patchFile = `${context.run.cwd}/__optimize.patch`;
        await context.shell(
          `cat > "${patchFile}" << 'PATCH_EOF'\n${patch}\nPATCH_EOF`,
          { timeoutMs: 10000 },
        );
        const applyRes = await context.shell(
          `git apply --check "${patchFile}" 2>&1 && git apply "${patchFile}" 2>&1`,
          { timeoutMs: 10000 },
        );

        if (applyRes.exitCode !== 0) {
          context.log(`Patch apply failed: ${applyRes.stderr || applyRes.stdout}`);
          await context.shell(`rm -f "${patchFile}"`, { timeoutMs: 5000 });
          continue;
        }

        const measureRes = await context.shell(
          `TOPIC="${topic}" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts`,
          { timeoutMs: 600000 },
        );
        newMetrics = parseMetrics(measureRes.stdout);

        // Revert the patch (will re-apply if we decide to keep)
        await context.shell(`git apply -R "${patchFile}"`, { timeoutMs: 10000 });
      }

      if (!newMetrics) {
        context.log(`Attempt ${attempt}: patch failed to apply or measure failed`);
        continue;
      }

      const newScore = newMetrics.quality_score ?? 0;
      const gateStatus = checkHardGates(newMetrics);
      const delta = newScore - oldScore;

      context.log(
        `Attempt ${attempt}: score ${oldScore.toFixed(4)} → ${newScore.toFixed(4)} ` +
        `(delta=${delta >= 0 ? "+" : ""}${delta.toFixed(4)}, gates=${gateStatus.violated ? "FAIL" : "OK"})`,
      );

      // ── Phase 4: AUTONOMOUS DECISION ─────────────────────────────
      const improved = delta > 0.001;
      const gatesOk = !gateStatus.violated;

      if (improved && gatesOk) {
        // KEEP
        context.phase(`merge`);
        if (gitClean) {
          await context.shell(`git merge optimize-attempt --no-edit`, { timeoutMs: 30000 });
          context.log(`Merged optimize-attempt branch`);
        } else {
          await context.shell(`git apply "${patchFile}"`, { timeoutMs: 10000 });
          await context.shell(`rm -f "${patchFile}"`, { timeoutMs: 5000 });
          context.log(`Re-applied patch (in-place)`);
        }

        return {
          old_score: oldScore,
          new_score: newScore,
          delta,
          kept: true,
          patch_summary: rationale,
          hard_gate_status: gateStatus,
        };
      }

      if (!gatesOk && attempt < maxAttempts) {
        // RETRY with feedback
        context.log(`Hard gate violated: ${gateStatus.violations.join(", ")}. Retrying...`);
        if (!gitClean) await context.shell(`rm -f "${patchFile}"`, { timeoutMs: 5000 });
        continue;
      }

      // DISCARD
      if (!gitClean) await context.shell(`rm -f "${patchFile}"`, { timeoutMs: 5000 });
      return {
        old_score: oldScore,
        new_score: newScore,
        delta,
        kept: false,
        patch_summary: gatesOk ? rationale : `Hard gate violated: ${gateStatus.violations.join(", ")}`,
        hard_gate_status: gateStatus,
      };
    }

    // All attempts exhausted
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
3. source_quality (15%): Primary sources? Independent? Diverse publishers? Penalize citation spam (many weak sources ≠ good diversity).
4. coverage (15%): Does it fully answer the research question?
5. contradiction_handling (10%): Does it surface disagreements rather than averaging?
6. analytical_depth (5%): Does it synthesize novel insights beyond summarizing sources?
7. timeliness (5%): Is the information current as of the research date?
8. structure_actionability (5%): Well-organized? Can a decision-maker act on it?
9. conciseness (5%): Is every sentence earning its place? Penalize filler/repetition.

For each criterion:
- Score A (1-5)
- Score B (1-5)
- One-sentence justification for the scores

Then state:
- composite_A (weighted sum, 0-5)
- composite_B (weighted sum, 0-5)
- preference: "A", "B", or "tie"
- confidence: "high", "medium", or "low"

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

    context.phase("candidate");
    context.log(`Running candidate (dr_research) on: ${topic.slice(0, 60)}...`);

    // ── Phase 1: CANDIDATE ──────────────────────────────────────────
    // Use our existing smoke suite — it creates a Pi session, calls dr_research,
    // computes metrics, saves report to test/results/<slug>/ours_report.md
    const candidateRes = await context.shell(
      `TOPIC="${topic}" MODEL="zai/glm-4.5-air" bun test/suites/smoke.ts`,
      { timeoutMs: 600000 },
    );

    if (candidateRes.exitCode !== 0) {
      throw new Error(`Candidate run failed: ${candidateRes.stderr || candidateRes.stdout}`);
    }

    // Read the report
    const reportReadRes = await context.shell(
      `cat test/results/${slug}/ours_report.md`,
      { timeoutMs: 5000 },
    );
    const oursReport = reportReadRes.stdout;

    if (!oursReport || oursReport.length < 100) {
      throw new Error(`Candidate report too short or missing at test/results/${slug}/ours_report.md`);
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

      // Save the reference
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
          model: "gpt-5.6-sol",
          thinking: "max",
          outputSchema: JUROR_OUTPUT_SCHEMA,
          timeoutMs: 300000,
        }),
      run2: () =>
        context.agent(jurorPrompt(topic, reportB, reportA), {
          label: "juror-run-2",
          model: "gpt-5.6-sol",
          thinking: "max",
          outputSchema: JUROR_OUTPUT_SCHEMA,
          timeoutMs: 300000,
        }),
    });

    // ── Phase 4: AGGREGATE ──────────────────────────────────────────
    context.phase("aggregate");

    // Save juror runs and labels
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

    // Aggregate using our existing gate logic
    const aggregateRes = await context.shell(
      `bun test/suites/judge.ts --aggregate ${slug}`,
      { timeoutMs: 60000 },
    );

    const passed = aggregateRes.exitCode === 0;

    // Parse verdict from the METRIC lines
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
  roleDirectories: [new URL("./roles/", import.meta.url)],
};

export default function extension() {
  registerWorkflowExtension(drWorkflowExtension);
}
