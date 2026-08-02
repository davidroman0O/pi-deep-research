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
//
// DRH recommendation: add deterministic proxies for the 4 juror-only criteria
// (analytical_depth, timeliness, structure_actionability, conciseness) so the
// optimizer has levers beyond the 5 original proxies. Max composite was 4.0
// with zeros; now it can reach 5.0.
 */
export function proxyScores(m: RunMetrics, report?: string): Record<string, number> {
	return {
		// citation_integrity: continuous scale (DRH #4: rounding created ±0.3 discontinuities)
		citation_integrity: Math.max(1, Math.min(5, m.citationPassRate * 5)),

		// coverage: dimensions covered / total
		coverage: m.dimensionsTotal > 0
			? Math.max(1, Math.min(5, Math.round((m.dimensionsCovered / m.dimensionsTotal) * 5)))
			: 1,

		// source_quality: based on publisher diversity (lower concentration = better)
		source_quality: Math.max(1, Math.min(5, Math.round((1 - m.publisherConcentration) * 5))),

		// contradiction_handling: acknowledged = good
		contradiction_handling: m.contradictionsAcknowledged ? 4 : m.contradictionsDetected > 0 ? 2 : 3,

		// factual_accuracy: proxy via corroboration fraction — continuous scale
		factual_accuracy: Math.max(1, Math.min(5, 1 + m.corroboratedFraction * 4)),

		// ── DRH-added deterministic proxies (were always 0) ─────────────

		// analytical_depth: corroborated claims on log scale (deeper = more verified claims)
		analytical_depth: Math.max(1, Math.min(5, 1 + Math.log2(Math.max(1, m.corroboratedClaims)) * 0.5)),

		// timeliness: fraction of recent year references (2024+) in report text
		timeliness: (() => {
			if (!report) return 3;
			const years = report.match(/20\d{2}/g) ?? [];
			if (years.length === 0) return 3;
			const recent = years.filter(y => parseInt(y) >= 2024).length;
			return Math.max(1, Math.min(5, 1 + (recent / years.length) * 4));
		})(),

		// structure_actionability: section count + recommendation keywords
		structure_actionability: (() => {
			if (!report) return 3;
			const headings = (report.match(/^#{1,3}\s/gm) ?? []).length;
			const hasRec = /recommend|should|action item|next step|implication|takeaway/i.test(report);
			return Math.max(1, Math.min(5, 1 + headings * 0.15 + (hasRec ? 1.5 : 0)));
		})(),

		// conciseness: penalize redundancy and verbosity, not density (DRH #4: old formula saturated at 1.33%)
		conciseness: (() => {
			if (!report || m.claims === 0) return 3;
			const words = report.split(/\s+/).length;
			const claimsPerKword = m.claims / (words / 1000); // claim density per 1000 words
			// Sweet spot: 30-80 claims per 1000 words. Below 30 = verbose, above 80 = claim-stacking.
			const densityScore = claimsPerKword < 30 ? 1 + claimsPerKword / 30 * 2
				: claimsPerKword <= 80 ? 3 + (80 - claimsPerKword) / 50 * 2
				: Math.max(1, 3 - (claimsPerKword - 80) / 40);
			return Math.max(1, Math.min(5, densityScore));
		})(),
	};
}
