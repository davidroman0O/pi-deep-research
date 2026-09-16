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
//
// When a DRH reference report is supplied, two reference-relative signals fold
// into the proxies (reverse-engineering DRH is the goal, so the fast loop must
// reward fact coverage and depth relative to the reference artifact):
//   - fact_recall: fraction of the reference's distinctive numeric facts present
//     in ours (±5% tolerance) → folds into factual_accuracy
//   - depth_ratio: ours words vs reference words → folds into analytical_depth
 */
/** Fact-recall + depth ratio of ours vs the DRH reference (for METRIC lines + logging). */
export function referenceSignals(report: string | null, reference: string): { factRecallVsReference: number; depthRatioVsReference: number } {
	if (!report) return { factRecallVsReference: 0, depthRatioVsReference: 0 };
	const refFacts = extractReferenceFacts(reference);
	let found = 0;
	for (const value of refFacts) if (hasValueNear(report, value)) found++;
	const factRecallVsReference = refFacts.length > 0 ? found / refFacts.length : 0;
	const depthRatioVsReference = Math.min(1, report.split(/\s+/).length / Math.max(1, reference.split(/\s+/).length * 0.6));
	return { factRecallVsReference, depthRatioVsReference };
}

export function proxyScores(m: RunMetrics, report?: string, reference?: string): Record<string, number> {
	// ── reference-relative signals (only when a DRH reference exists) ──
	let factRecall: number | null = null;
	let depthRatio: number | null = null;
	if (reference && report) {
		const refFacts = extractReferenceFacts(reference);
		if (refFacts.length >= 10) {
			let found = 0;
			for (const value of refFacts) if (hasValueNear(report, value)) found++;
			factRecall = found / refFacts.length;
		}
		const refWords = reference.split(/\s+/).length;
		const ourWords = report.split(/\s+/).length;
		depthRatio = Math.min(1, ourWords / Math.max(1, refWords * 0.6));
	}

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

		// factual_accuracy: corroboration + (when reference exists) fact recall vs DRH
		factual_accuracy: factRecall === null
			? Math.max(1, Math.min(5, 1 + m.corroboratedFraction * 4))
			: Math.max(1, Math.min(5, 0.5 * (1 + m.corroboratedFraction * 4) + 0.5 * (1 + factRecall * 4))),

		// ── DRH-added deterministic proxies (were always 0) ─────────────

		// analytical_depth: corroborated claims + depth vs reference (when supplied)
		analytical_depth: (() => {
			const base = 1 + Math.log2(Math.max(1, m.corroboratedClaims)) * 0.5;
			if (depthRatio === null) return Math.max(1, Math.min(5, base));
			return Math.max(1, Math.min(5, 0.6 * base + 0.4 * (1 + depthRatio * 4)));
		})(),

		// timeliness: recency of year references in the PROSE — reference tables
		// legitimately cite historical cost vintages and must not dilute the signal.
		timeliness: (() => {
			if (!report) return 3;
			const years = narrativeOnly(report).match(/20\d{2}/g) ?? [];
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

		// conciseness: penalize redundancy and verbosity in the PROSE. Reference
		// tables (Consolidated Evidence appendix) are dense lookup material, not
		// prose — excluded from the word count so depth is not punished twice
		// (their claims already count toward m.claims).
		conciseness: (() => {
			if (!report || m.claims === 0) return 3;
			const prose = narrativeOnly(report);
			const words = prose.split(/\s+/).length;
			const claimsPerKword = m.claims / (words / 1000); // claim density per 1000 prose words
			// Sweet spot: 30-80 claims per 1000 words. Below 30 = verbose, above 80 = claim-stacking.
			const densityScore = claimsPerKword < 30 ? 1 + claimsPerKword / 30 * 2
				: claimsPerKword <= 80 ? 3 + (80 - claimsPerKword) / 50 * 2
				: Math.max(1, 3 - (claimsPerKword - 80) / 40);
			return Math.max(1, Math.min(5, densityScore));
		})(),
	};
}

// ── reference-relative fact extraction (reverse-engineering DRH) ─────────

interface ReferenceFact { value: number; unit: string }

/** Distinctive numeric facts WITH their unit context: $/kW, /MWh, %, bn, MW… (years excluded).
 * DRH review 5 P1: bare-number recall is unit/basis-blind ($4,000M must never match $4,000/kW). */
function extractReferenceFacts(reference: string): ReferenceFact[] {
	const seen = new Map<string, number>();
	for (const match of reference.matchAll(/([$€£]|USD\s?|CAD\s?|C\$)?\s?(\d[\d,]*)(?:\.\d+)?\s?(kW\w*|\/kW\w*|\/MWh|MW\b|GW\b|billion|million|bn|%|MWh)?/gi)) {
		const raw = match[2].replace(/,/g, "");
		const n = Number(raw);
		// distinctive magnitudes only: skip years, small counts, page numbers
		if (Number.isNaN(n) || n < 100 || n > 1e12) continue;
		if (/^(18|19|20|21)\d{2}$/.test(raw)) continue;
		const currency = (match[1] ?? "").trim().toLowerCase();
		const unit = ((match[3] ?? "") + " " + currency).trim().toLowerCase();
		const key = n + "|" + unit;
		if (!seen.has(key)) seen.set(key, n);
		if (seen.size >= 60) break;
	}
	return [...seen.entries()].map(([key, value]) => ({ value, unit: key.split("|")[1] }));
}

/** Does ours contain this value NEAR ITS UNIT CONTEXT (±5%, same-line window)?
 * DRH review 5: bare-number matching is dimensionally blind ($4,000M must never match $4,000/kW).
 * A match requires the reference fact's unit token to co-occur in the matching line. */
function hasValueNear(report: string, fact: { value: number; unit: string }): boolean {
	const normalized = report.replace(/,/g, "");
	for (const line of normalized.split("\n")) {
		for (const match of line.matchAll(/\d+(?:\.\d+)?/g)) {
			const n = Number(match[0]);
			if (n > 0 && Math.abs(n - fact.value) / Math.max(fact.value, n) < 0.05) {
				if (!fact.unit) return true;
				const window = line.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 60).toLowerCase();
				if (window.includes(fact.unit)) return true;
			}
		}
	}
	return false;
}


/** Strip reference-table appendices: proxies judge the narrative, not lookup material. */
function narrativeOnly(report: string): string {
	const cut = report.search(/\n## Consolidated Evidence Tables/);
	return cut >= 0 ? report.slice(0, cut) : report;
}

