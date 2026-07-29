// test/suites/regression.ts — full regression (~30 min, 4 topics, no juror).
//
// Runs the candidate on all regression topics, computes deterministic metrics,
// and asserts quality thresholds:
//   - coverage ≥ 80%
//   - citation pass rate ≥ 75%
//   - corroboration ≥ 10%
//   - sources ≥ 10 per topic
//   - no critical failures
//
// Does NOT run juror or DRH reference — use judge.ts for full quality gate.
//
// Usage:
//   bun test/suites/regression.ts                    # all 4 topics
//   TOPICS="smr-cost,battery-storage" bun test/suites/regression.ts  # subset

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCandidate } from "../runners/candidate.ts";
import { slugify, ensureTopicDir, saveReport, saveJson, appendLog } from "../lib/artifacts.ts";
import {
	assert,
	assertReportExists,
	assertCitationsEntailed,
	assertCoverage,
	assertCorroboration,
	assertSourcesSufficient,
	assertNoCriticalFailures,
} from "../lib/assertions.ts";
import { formatMetrics } from "../lib/metrics.ts";
import type { TestConfig } from "../lib/types.ts";

const REGRESSION_DIR = "test/regression";
const TOPIC_FILTER = process.env.TOPICS?.split(",").map((t) => t.trim());

let failures = 0;
let topicsRun = 0;

async function loadTopics(): Promise<Array<TestConfig & { slug: string }>> {
	if (!existsSync(REGRESSION_DIR)) {
		throw new Error(`No regression corpus at ${REGRESSION_DIR}`);
	}
	const files = await readdir(REGRESSION_DIR);
	const topics: Array<TestConfig & { slug: string }>[] = [];

	for (const file of files.filter((f) => f.endsWith(".json"))) {
		const name = file.replace(".json", "");
		if (TOPIC_FILTER && !TOPIC_FILTER.includes(name)) continue;

		const raw = JSON.parse(await readFile(join(REGRESSION_DIR, file), "utf8"));
		const config: TestConfig & { slug: string } = {
			topic: raw.topic,
			profile: raw.profile ?? "standard",
			model: process.env.MODEL,
			ttl_days: raw.ttl_days,
			expected_dimensions: raw.expected_dimensions,
			slug: slugify(raw.topic),
		};
		topics.push([config]);
	}
	return topics.flat();
}

async function main() {
	console.log("=== REGRESSION SUITE ===\n");
	const topics = await loadTopics();
	console.log(`topics: ${topics.length}\n`);

	for (const config of topics) {
		console.log(`\n─── ${config.slug} ───`);
		console.log(`  "${config.topic.slice(0, 60)}…"`);

		try {
			const result = await runCandidate(config);

			// Assertions
			assert(result.wordCount > 100, `${config.slug}: report too short`);
			assertReportExists(result.runDir);

			if (result.metrics) {
				console.log(`  metrics: ${formatMetrics(result.metrics)}`);
				assertSourcesSufficient(result.metrics, 10);
				assertCoverage(result.metrics, 0.80);
				assertCitationsEntailed(result.metrics, 0.75);
				assertCorroboration(result.metrics, 0.10);
				assertNoCriticalFailures(result.metrics);
			}

			// Save artifacts
			const dir = await ensureTopicDir(config.slug);
			await saveReport(dir, "ours", result.report);
			await saveJson(dir, "topic.json", config);
			await appendLog(dir, { phase: "regression", wordCount: result.wordCount, metrics: result.metrics });

			console.log(`  ✅ PASSED`);
			topicsRun++;
		} catch (err) {
			console.error(`  ❌ FAILED: ${err instanceof Error ? err.message : err}`);
			failures++;
		}
	}

	console.log(`\n=== REGRESSION RESULTS ===`);
	console.log(`topics run: ${topicsRun}`);
	console.log(`failures: ${failures}`);
	console.log(failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILURE(S)`);

	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("❌ REGRESSION SUITE CRASHED:", err.message);
	process.exit(1);
});
