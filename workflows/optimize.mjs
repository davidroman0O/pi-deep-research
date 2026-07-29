// workflows/optimize.mjs — one autonomous optimization iteration.
//
// Called via: workflow({ scriptPath: "workflows/optimize.mjs", name: "drOptimize", args: { topic: "..." } })
//
// Flow: baseline measure → agent generates patch → test in-place → keep/discard

// ── helpers (available as globals in the workflow sandbox) ──────────────

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

function checkHardGates(metrics) {
  const violations = [];
  const factual = metrics.factual_accuracy ?? 0;
  const citation = metrics.citation_integrity ?? 0;
  if (factual < 3) violations.push("factual_accuracy=" + factual + " < 3");
  if (citation < 3) violations.push("citation_integrity=" + citation + " < 3");
  return { violated: violations.length > 0, violations, factual, citation };
}

// ── main ────────────────────────────────────────────────────────────────

const topic = args.topic;
const targetFiles = args.target_files ?? [
  "src/prompts.ts",
  "src/prompts-policy.ts",
  "src/orchestrator.ts",
];
const maxAttempts = args.max_attempts ?? 3;

// ── Phase 1: BASELINE MEASURE ───────────────────────────────────────────
phase("baseline-measure");

const baselineRes = await shell(
  'TOPIC="' + topic + '" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts',
  { timeoutMs: 600000 },
);

const baselineMetrics = parseMetrics(baselineRes.stdout);
const oldScore = baselineMetrics.quality_score ?? 0;
log("Baseline: quality_score=" + oldScore.toFixed(4));

// ── Phase 2-N: PATCH ATTEMPTS ───────────────────────────────────────────
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  phase("patch-attempt-" + attempt);

  const metricsStr = JSON.stringify(baselineMetrics, null, 2);
  const patchResult = await agent(
    prompt(
      "You are optimizing pi-deep-research.\n\n" +
      "Current metrics:\n{metrics}\n\n" +
      "You may modify these files: {files}\n\n" +
      "Focus on the weakest criterion. Generate a small, targeted patch.\n" +
      "Read the files first, then return a unified diff.",
      { metrics: metricsStr, files: targetFiles.join(", ") },
    ),
    {
      label: "optimizer-attempt-" + attempt,
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
    log("Attempt " + attempt + ": no patch generated (" + rationale + ")");
    continue;
  }

  // ── Phase 3: IN-PLACE TEST ───────────────────────────────────────
  phase("test-attempt-" + attempt);

  // Write patch to temp file
  await shell('cat > __optimize.patch << \'PATCH_EOF\'\n' + patch + '\nPATCH_EOF', { timeoutMs: 10000 });

  const applyRes = await shell(
    "git apply --check __optimize.patch 2>&1 && git apply __optimize.patch 2>&1",
    { timeoutMs: 10000 },
  );

  if (applyRes.exitCode !== 0) {
    log("Patch apply failed: " + (applyRes.stderr || applyRes.stdout));
    await shell("rm -f __optimize.patch", { timeoutMs: 5000 });
    continue;
  }

  const measureRes = await shell(
    'TOPIC="' + topic + '" MODEL="zai/glm-4.5-air" bun test/suites/autoresearch-measure.ts',
    { timeoutMs: 600000 },
  );

  const newMetrics = parseMetrics(measureRes.stdout);
  const newScore = newMetrics.quality_score ?? 0;
  const gateStatus = checkHardGates(newMetrics);
  const delta = newScore - oldScore;

  log(
    "Attempt " + attempt + ": score " + oldScore.toFixed(4) + " → " + newScore.toFixed(4) +
    " (delta=" + (delta >= 0 ? "+" : "") + delta.toFixed(4) + ", gates=" + (gateStatus.violated ? "FAIL" : "OK") + ")",
  );

  // Revert the patch (will re-apply if we decide to keep)
  await shell("git apply -R __optimize.patch", { timeoutMs: 10000 });

  // ── Phase 4: AUTONOMOUS DECISION ────────────────────────────────
  const improved = delta > 0.001;
  const gatesOk = !gateStatus.violated;

  if (improved && gatesOk) {
    // KEEP: re-apply the patch
    phase("merge");
    await shell("git apply __optimize.patch", { timeoutMs: 10000 });
    await shell("rm -f __optimize.patch", { timeoutMs: 5000 });
    log("Re-applied patch (kept)");

    return {
      old_score: oldScore,
      new_score: newScore,
      delta: delta,
      kept: true,
      patch_summary: rationale,
      hard_gate_status: gateStatus,
    };
  }

  if (!gatesOk && attempt < maxAttempts) {
    log("Hard gate violated: " + gateStatus.violations.join(", ") + ". Retrying...");
    await shell("rm -f __optimize.patch", { timeoutMs: 5000 });
    continue;
  }

  // DISCARD
  await shell("rm -f __optimize.patch", { timeoutMs: 5000 });
  return {
    old_score: oldScore,
    new_score: newScore,
    delta: delta,
    kept: false,
    patch_summary: gatesOk ? rationale : "Hard gate violated: " + gateStatus.violations.join(", "),
    hard_gate_status: gateStatus,
  };
}

// All attempts exhausted
return {
  old_score: oldScore,
  new_score: oldScore,
  delta: 0,
  kept: false,
  patch_summary: "All " + maxAttempts + " attempts failed",
  hard_gate_status: checkHardGates(baselineMetrics),
};
