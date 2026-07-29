// test/suites/judge.ts — full judge pipeline (~60 min, 1 topic, juror ×2).
//
// The COMPLETE quality gate:
//   1. Run candidate (our dr_research via Pi session)
//   2. Get DRH reference (cached, TTL-managed)
//   3. Generate blind juror prompts (swapped ×2)
//   4. [Delegated] Run juror evaluations via gpt_chat agent mode
//   5. Aggregate verdict + apply pass/fail gate
//
// The juror step (4) requires gpt_chat, which is a Pi session tool.
// When run standalone, this suite:
//   - Completes steps 1-3
//   - Saves juror prompts to disk
//   - Prints instructions for running the juror
//   - Exits with code 0 (prompts ready)
//
// When run from within a Pi session (e.g., autoresearch with interactive_shell),
// the caller can automate step 4 and then call aggregate:
//   bun test/suites/judge.ts --aggregate <slug>
//
// Usage:
//   bun test/suites/judge.ts                           # run candidate + generate prompts
//   bun test/suites/judge.ts --aggregate <slug>        # aggregate existing juror runs
//   TOPIC="..." MODEL="..." bun test/suites/judge.ts

import { runCandidate } from "../runners/candidate.ts";
import { getReference } from "../runners/reference.ts";
import { generatePrompts, savePrompts, aggregateVerdict, formatVerdict } from "../runners/juror.ts";
import { slugify, ensureTopicDir, saveReport, saveJson, loadJson, appendLog } from "../lib/artifacts.ts";
import { healthCheck, checkDrhQuota } from "../lib/session.ts";
import { calibrate, recordVerdict, loadHistory, checkHardGateBaselines, findBorderline } from "../gate/threshold.ts";
import { formatBiasReport, auditBiases } from "../gate/bias-audit.ts";
import type { TestConfig, JurorRun, JurorLabels, Verdict } from "../lib/types.ts";

const AGGREGATE_MODE = process.argv.includes("--aggregate");
const AGGREGATE_SLUG = process.argv[process.argv.indexOf("--aggregate") + 1];

const DEFAULT_TOPIC = "What is the current capital cost per kW of small modular reactors?";

const config: TestConfig = {
	topic: process.env.TOPIC ?? DEFAULT_TOPIC,
	profile: (process.env.PROFILE as TestConfig["profile"]) ?? "standard",
	model: process.env.MODEL,
	ttl_days: 365, // SMR is stable
};

// ── aggregate mode: read existing juror runs and produce verdict ──────────

async function aggregateMode(slug: string) {
	console.log(`=== JUDGE AGGREGATE: ${slug} ===\n`);

	const dir = `test/results/${slug}`;
	const run1 = await loadJson<JurorRun>(dir, "juror-run1.json");
	const run2 = await loadJson<JurorRun>(dir, "juror-run2.json");
	const labels = await loadJson<JurorLabels>(dir, "labels.json");

	if (!run1 || !run2 || !labels) {
		console.error("❌ Missing juror runs or labels. Run the juror evaluations first.");
		console.error(`   Expected: ${dir}/juror-run1.json, juror-run2.json, labels.json`);
		process.exit(1);
	}

	// Calibrate threshold from history
	const history = await loadHistory();
	const threshold = calibrate(history);

	// Aggregate
	const verdict = aggregateVerdict(run1, run2, labels, threshold);
	await saveJson(dir, "verdict.json", verdict);
	await recordVerdict(slug, verdict);

	// Check hard-gate baselines
	const gateCheck = checkHardGateBaselines(verdict, history);
	if (gateCheck.violated) {
		console.log("⚠ HARD-GATE BASELINE REGRESSION:");
		for (const r of gateCheck.regressions) console.log(`  • ${r}`);
	}

	// Check for borderline verdicts (§5.2)
	const borderline = findBorderline(verdict);
	if (borderline.borderline) {
		console.log(`\n⚠ BORDERLINE: ${borderline.reason}`);
	}

	// Display
	console.log(formatVerdict(verdict));

	// Bias audit
	console.log("\n" + formatBiasReport(await auditBiases("test/results")));

	// METRIC lines for autoresearch
	console.log(`\nMETRIC quality_score=${verdict.ours_composite.toFixed(4)}`);
	console.log(`METRIC reference_score=${verdict.drh_composite.toFixed(4)}`);
	console.log(`METRIC ratio=${verdict.ratio.toFixed(4)}`);
	console.log(`METRIC passed=${verdict.pass ? 1 : 0}`);
	for (const pc of verdict.per_criterion) {
		console.log(`METRIC ${pc.criterion}=${pc.ours.toFixed(2)}`);
	}

	process.exit(verdict.pass ? 0 : 1);
}

// ── normal mode: run candidate + generate juror prompts ───────────────────

async function main() {
	if (AGGREGATE_MODE && AGGREGATE_SLUG) {
		return aggregateMode(AGGREGATE_SLUG);
	}

	console.log("=== JUDGE PIPELINE ===");
	console.log(`topic: "${config.topic.slice(0, 60)}…"`);
	console.log(`profile: ${config.profile}\n`);

	// ── health check ───────────────────────────────────────────────────
	console.log("=== HEALTH CHECK ===");
	const health = await healthCheck(checkDrhQuota);
	if (!health.ok) {
		for (const issue of health.issues) console.log(`  ⚠ ${issue}`);
		if (health.models === 0) {
			console.error("❌ No models available — aborting");
			process.exit(1);
		}
	}
	console.log();

	const slug = slugify(config.topic);
	const dir = await ensureTopicDir(slug);

	// ── Step 1: Candidate ─────────────────────────────────────────────
	console.log("=== STEP 1: CANDIDATE ===");
	const candidate = await runCandidate(config);
	await saveReport(dir, "ours", candidate.report);
	await saveJson(dir, "topic.json", { ...config, slug });
	await appendLog(dir, { phase: "judge-candidate", wordCount: candidate.wordCount });
	console.log();

	// ── Step 2: Reference (DRH) ───────────────────────────────────────
	console.log("=== STEP 2: REFERENCE (DRH) ===");
	const ref = await getReference(dir, config.ttl_days ?? 365, config.topic);

	if (ref.regenerate) {
		console.log("\n  ⚠ No cached DRH reference.");
		console.log("  " + (ref.instructions ?? "").split("\n").join("\n  "));

		// Still generate juror prompts so they're ready once reference exists
		console.log("\n  Generating juror prompts with placeholder reference...");
		console.log("  (Replace drh_report.md before running juror)");
	}

	// ── Step 3: Generate juror prompts ────────────────────────────────
	console.log("\n=== STEP 3: JUROR PROMPTS ===");
	const drhReport = ref.report || "[DRH REFERENCE REPORT PLACEHOLDER — replace this]";
	const prompts = generatePrompts(config.topic, candidate.report, drhReport);
	await savePrompts(dir, prompts);
	await appendLog(dir, { phase: "judge-prompts-generated" });

	console.log("  ✓ juror prompts saved:");
	console.log(`    ${dir}/juror-prompt-1.md`);
	console.log(`    ${dir}/juror-prompt-2.md`);
	console.log(`    ${dir}/labels.json`);
	console.log();
	console.log("  To run the juror:");
	console.log("    1. Use gpt_chat agent mode with each prompt file");
	console.log("    2. Save results as juror-run1.json and juror-run2.json");
	console.log("    3. Run: bun test/suites/judge.ts --aggregate " + slug);
	console.log();
	console.log("  Or from a Pi session, use interactive_shell to automate steps 1-2.");
	console.log();

	if (ref.regenerate) {
		console.log("  NOTE: DRH reference is missing/stale. Generate it first:");
		console.log(`    gpt_chat deep_research_heavy "${config.topic}"`);
		console.log(`    → save to ${dir}/drh_report.md`);
		console.log(`    → re-run this suite to regenerate prompts with real reference`);
	}

	console.log(`\n✅ Steps 1-3 complete. Juror prompts ready at ${dir}`);
}

main().catch((err) => {
	console.error("❌ JUDGE PIPELINE FAILED:", err.message);
	process.exit(1);
});
