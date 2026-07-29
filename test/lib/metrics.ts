// test/lib/metrics.ts — quality metric extractor from run artifacts.
//
// Reads the on-disk artifacts from a candidate run and computes the
// deterministic metrics (no LLM calls). Used by the fast autoresearch loop
// and the regression suite.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { RunStore } from "../../src/store.ts";
import { computeMetrics } from "../../src/metrics.ts";
import type { RunMetrics } from "./types.ts";

/**
// Compute deterministic metrics from a candidate run's on-disk artifacts.
// @param cwd — the session's working directory (where .pi/research/ lives)
// @returns metrics or null if artifacts are missing
 */
export async function computeRunMetrics(cwd: string): Promise<RunMetrics | null> {
	const researchDir = join(cwd, ".pi", "research");
	if (!existsSync(researchDir)) { console.error("  [metrics] no .pi/research/ at " + cwd); return null; }

	const { readdir } = await import("node:fs/promises");
	let runDirs: string[] = [];
	try { runDirs = await readdir(researchDir); } catch { return null; }
	if (runDirs.length === 0) { console.error("  [metrics] no run dirs"); return null; }

	const runId = runDirs[0];
	const store = new RunStore(cwd, runId);

	const metaPath = store.metaFile();
	if (!existsSync(metaPath)) { console.error("  [metrics] no run.json at " + metaPath); return null; }

	const meta = await store.loadMeta();
	const sources = await store.loadSources();
	const evidence = await store.loadEvidence();
	const claims = await store.loadClaims();
	const edges = await store.loadEdges();

	const auditPath = store.auditFile();
	if (!existsSync(auditPath)) { console.error("  [metrics] no audit.json at " + auditPath + " (sources=" + sources.length + ", evidence=" + evidence.length + ", claims=" + claims.length + ")"); return null; }
	if (!meta?.spec) { console.error("  [metrics] no spec in run.json"); return null; }

	const audit = JSON.parse(await readFile(auditPath, "utf8"));
	const m = computeMetrics(meta.spec, sources, evidence, claims, edges, audit);

	return {
		sources: m.sources,
		independentPublishers: m.independentPublishers,
		evidenceRecords: m.evidenceRecords,
		claims: m.claims,
		claimsCitationReady: m.claimsCitationReady,
		corroboratedClaims: m.corroboratedClaims,
		corroboratedFraction: m.corroboratedFraction,
		contradictionsDetected: m.contradictionsDetected,
		contradictionsAcknowledged: m.contradictionsAcknowledged,
		dimensionsCovered: m.dimensionsCovered,
		dimensionsTotal: m.dimensionsTotal,
		citationPassRate: m.citationPassRate,
		publisherConcentration: m.publisherConcentration,
	};
}

/**
// Format metrics as a human-readable summary line.
 */
export function formatMetrics(m: RunMetrics): string {
	return `${m.sources} sources, ${m.evidenceRecords} evidence, ${m.claims} claims, ` +
		`${(m.corroboratedFraction * 100).toFixed(0)}% corroboration, ` +
		`${(m.citationPassRate * 100).toFixed(0)}% citation pass, ` +
		`${m.dimensionsCovered}/${m.dimensionsTotal} dimensions`;
}

/**
// Map deterministic metrics to approximate rubric-style scores (1-5).
// Used by the autoresearch fast loop as a cheap proxy for the LLM juror.
// These are NOT the real juror scores — they're fast heuristics.
 */
export function proxyScores(m: RunMetrics): Record<string, number> {
	return {
		// citation_integrity: map pass rate to 1-5
		citation_integrity: Math.max(1, Math.min(5, Math.round(m.citationPassRate * 5))),

		// coverage: dimensions covered / total
		coverage: m.dimensionsTotal > 0
			? Math.max(1, Math.min(5, Math.round((m.dimensionsCovered / m.dimensionsTotal) * 5)))
			: 1,

		// source_quality: based on publisher diversity (lower concentration = better)
		source_quality: Math.max(1, Math.min(5, Math.round((1 - m.publisherConcentration) * 5))),

		// contradiction_handling: acknowledged = good
		contradiction_handling: m.contradictionsAcknowledged ? 4 : m.contradictionsDetected > 0 ? 2 : 3,

		// factual_accuracy: proxy via corroboration fraction
		factual_accuracy: Math.max(1, Math.min(5, Math.round(m.corroboratedFraction * 5))),
	};
}
