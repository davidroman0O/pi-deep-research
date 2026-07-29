// test/suites/smoke.ts — quick smoke test (~5 min, 1 topic, candidate only).
//
// Verifies the FULL stack works:
//   extension loads → tool discovered → tool called → report produced → no crash
//
// Does NOT verify quality (use regression.ts for that).
// Does NOT run juror (use judge.ts for that).
//
// Usage:
//   bun test/suites/smoke.ts                          # default topic, quick profile
//   TOPIC="..." MODEL="zai/glm-4.5-air" bun test/suites/smoke.ts

import { runCandidate } from "../runners/candidate.ts";
import { healthCheck } from "../lib/session.ts";
import { slugify, ensureTopicDir, saveReport, saveJson, appendLog } from "../lib/artifacts.ts";
import { assert, assertReportExists, assertSourcesSufficient } from "../lib/assertions.ts";
import type { TestConfig } from "../lib/types.ts";

const config: TestConfig = {
	topic: process.env.TOPIC ?? "What is the current capital cost per kW of small modular reactors?",
	profile: "quick",
	model: process.env.MODEL,
};

async function main() {
	console.log("=== SMOKE TEST ===");
	console.log(`topic: "${config.topic.slice(0, 60)}…"`);
	console.log(`profile: ${config.profile}\n`);

	// ── health check ───────────────────────────────────────────────────
	console.log("=== HEALTH CHECK ===");
	const health = await healthCheck();
	if (!health.ok) {
		console.log("⚠ Health issues:");
		for (const issue of health.issues) console.log(`  • ${issue}`);
	}
	console.log(`  extensions: ${health.extensions.join(", ") || "(none)"}`);
	console.log(`  models: ${health.models}`);
	console.log();

	// ── candidate run ──────────────────────────────────────────────────
	console.log("=== CANDIDATE RUN ===");
	const result = await runCandidate(config);

	// ── assertions ────────────────────────────────────────────────────
	console.log("\n=== ASSERTIONS ===");
	assert(result.wordCount > 100, "Report too short", { wordCount: result.wordCount });
	assertReportExists(result.runDir);
	if (result.metrics) {
		assertSourcesSufficient(result.metrics, 3); // smoke uses lower bar
	}
	console.log("✅ all assertions passed");

	// ── save artifacts ────────────────────────────────────────────────
	const slug = slugify(config.topic);
	const dir = await ensureTopicDir(slug);
	await saveReport(dir, "ours", result.report);
	await saveJson(dir, "topic.json", { ...config, slug });
	await appendLog(dir, { phase: "smoke", wordCount: result.wordCount, metrics: result.metrics });

	console.log(`\n✅ SMOKE PASSED — ${result.wordCount} words`);
	if (result.metrics) {
		console.log(`   ${result.metrics.sources} sources, ${result.metrics.claims} claims`);
	}
	console.log(`   artifacts: ${dir}`);
}

main().catch((err) => {
	console.error("❌ SMOKE FAILED:", err.message);
	process.exit(1);
});
