// test/suites/autoresearch-measure.ts — autoresearch fast loop (~10 min).
//
// The CHEAP inner loop for autoresearch optimization. Uses deterministic
// metrics only — no LLM juror, no DRH reference. The expensive juror
// runs on a slower cadence via judge.ts (§9.2).
//
// Emits METRIC lines that autoresearch reads as the quality_score:
//   METRIC quality_score=<proxy composite>
//   METRIC citation_integrity=<proxy score>
//   METRIC coverage=<proxy score>
//   METRIC source_quality=<proxy score>
//   METRIC factual_accuracy=<proxy score>
//   METRIC contradiction_handling=<proxy score>
//   METRIC passed=<0|1>
//
// Hard gates (§9.2): factual_accuracy and citation_integrity must not decrease.
//
// Usage:
//   bun test/suites/autoresearch-measure.ts               # default topic
//   TOPIC="..." MODEL="..." bun test/suites/autoresearch-measure.ts

import { runCandidate } from "../runners/candidate.ts";
import { slugify, ensureTopicDir, saveReport, saveJson, appendLog } from "../lib/artifacts.ts";
import { proxyScores, formatMetrics } from "../lib/metrics.ts";
import { RUBRIC_WEIGHTS, DEFAULT_THRESHOLD } from "../lib/types.ts";
import { compositeFromScores } from "../gate/verdict.ts";
import type { TestConfig } from "../lib/types.ts";

const config: TestConfig = {
	topic: process.env.TOPIC ?? "What is the current capital cost per kW of small modular reactors?",
	profile: "benchmark",
	model: process.env.MODEL,
};

async function main() {
	console.log("=== AUTORESEARCH MEASURE ===");
	console.log(`topic: "${config.topic.slice(0, 60)}…"`);
	console.log(`profile: ${config.profile}\n`);

	// ── candidate run ──────────────────────────────────────────────────
	const result = await runCandidate(config);

	if (!result.metrics) {
		console.error("❌ No metrics computed — run artifacts missing");
		process.exit(1);
	}

	console.log(`  metrics: ${formatMetrics(result.metrics)}`);

	// ── proxy scores from deterministic metrics ────────────────────────
	const scores = proxyScores(result.metrics);
	const composite = compositeFromScores(scores, RUBRIC_WEIGHTS);

	// ── hard gates (§9.2) ──────────────────────────────────────────────
	const hardGateViolations: string[] = [];
	if (scores.factual_accuracy < DEFAULT_THRESHOLD.critical_floor) {
		hardGateViolations.push(`factual_accuracy ${scores.factual_accuracy} < ${DEFAULT_THRESHOLD.critical_floor}`);
	}
	if (scores.citation_integrity < DEFAULT_THRESHOLD.critical_floor) {
		hardGateViolations.push(`citation_integrity ${scores.citation_integrity} < ${DEFAULT_THRESHOLD.critical_floor}`);
	}

	const passed = hardGateViolations.length === 0;

	// ── save artifacts ─────────────────────────────────────────────────
	const slug = slugify(config.topic);
	const dir = await ensureTopicDir(slug);
	await saveReport(dir, "ours", result.report);
	await saveJson(dir, "topic.json", { ...config, slug });
	await saveJson(dir, "proxy-scores.json", { scores, composite, passed, hardGateViolations });
	await appendLog(dir, { phase: "autoresearch-measure", metrics: result.metrics, scores, composite });

	// ── emit METRIC lines (autoresearch reads these) ───────────────────
	// All 9 criteria: 5 have deterministic proxies, 4 are juror-only (emit 0)
	console.log(`\nMETRIC quality_score=${composite.toFixed(4)}`);
	console.log(`METRIC passed=${passed ? 1 : 0}`);
	// Proxy-scoreable criteria
	for (const [criterion, score] of Object.entries(scores)) {
		console.log(`METRIC ${criterion}=${score}`);
	}
	// Juror-only criteria — emit 0 so autoresearch sees all 9, but can't optimize them here
	console.log(`METRIC analytical_depth=0`);
	console.log(`METRIC timeliness=0`);
	console.log(`METRIC structure_actionability=0`);
	console.log(`METRIC conciseness=0`);
	// Raw deterministic metrics
	console.log(`METRIC sources=${result.metrics.sources}`);
	console.log(`METRIC corroboration=${result.metrics.corroboratedFraction.toFixed(4)}`);
	console.log(`METRIC citation_pass_rate=${result.metrics.citationPassRate.toFixed(4)}`);
	console.log(`METRIC coverage=${result.metrics.dimensionsTotal > 0 ? (result.metrics.dimensionsCovered / result.metrics.dimensionsTotal).toFixed(4) : "0"}`);

	if (!passed) {
		console.log(`\n⚠ HARD-GATE VIOLATIONS:`);
		for (const v of hardGateViolations) console.log(`  • ${v}`);
	}

	process.exit(passed ? 0 : 1);
}

main().catch((err) => {
	console.error("❌ MEASURE FAILED:", err.message);
	// Emit a zero score so autoresearch sees the failure
	console.log("METRIC quality_score=0");
	console.log("METRIC passed=0");
	process.exit(1);
});
