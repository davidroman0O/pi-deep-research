// test/runners/candidate.ts — run dr_research via a real Pi session.
//
// Creates a fresh session, prompts the agent to call dr_research,
// captures the report from disk, computes deterministic metrics.
//
// This is the ONLY runner that exercises the full extension stack:
// extension loading → tool discovery → agent interaction → tool execution
// → artifact persistence → metric extraction.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createCandidateSession, collectEvents } from "../lib/session.ts";
import { computeRunMetrics } from "../lib/metrics.ts";
import type { TestConfig, CandidateResult } from "../lib/types.ts";

/**
// Run the candidate (our dr_research) on a topic via a real Pi session.
//
// @returns the report text, the run directory, and deterministic metrics.
// @throws if the agent doesn't call dr_research or no report is produced.
 */
export async function runCandidate(config: TestConfig): Promise<CandidateResult> {
	console.log(`  candidate model: ${config.model ?? "default"}`);

	const { session, cwd } = await createCandidateSession(config.model);
	const { events, unsubscribe } = collectEvents(session);

	// Prompt the agent — must call the tool, not answer from memory
	await session.prompt(
		`Use the dr_research tool to investigate: "${config.topic}". ` +
		`Use profile: "${config.profile}". ` +
		`Do NOT answer from memory — you MUST call the dr_research tool.`,
	);
	unsubscribe();

	// Verify the agent called dr_research
	const drCall = events.find(
		(e) => e.type === "tool_execution_end" && (e as { toolName: string }).toolName === "dr_research",
	) as { toolName: string; isError?: boolean; details?: { run_id?: string; run_dir?: string } } | undefined;

	if (!drCall) {
		throw new Error("Agent never called dr_research — extension may not be loaded or model refused");
	}
	if (drCall.isError) {
		throw new Error("dr_research tool returned an error");
	}

	// Find the report on disk
	const researchDir = join(cwd, ".pi", "research");
	if (!existsSync(researchDir)) {
		throw new Error("No .pi/research/ directory — tool didn't persist artifacts");
	}
	const runDirs = await readdir(researchDir);
	if (runDirs.length === 0) {
		throw new Error("No run directories in .pi/research/");
	}
	const runId = runDirs[0];
	const reportPath = join(researchDir, runId, "report.md");
	if (!existsSync(reportPath)) {
		throw new Error(`report.md not found at ${reportPath}`);
	}

	const report = await readFile(reportPath, "utf8");
	const metrics = await computeRunMetrics(cwd);
	const wordCount = report.split(/\s+/).length;

	console.log(`  ✓ report: ${wordCount} words`);
	if (metrics) {
		console.log(`  ✓ metrics: ${metrics.sources} sources, ${metrics.claims} claims`);
	}

	return { report, runDir: join(researchDir, runId), metrics, wordCount };
}
