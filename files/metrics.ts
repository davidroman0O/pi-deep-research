// src/metrics.ts — research-quality metrics that actually matter.
//
// Line count is vanity. These measure whether the research is *better*:
//   - source plurality (how many distinct publishers)
//   - independent corroboration (claims backed by >=2 different publishers)
//   - contradiction surfacing (was disagreement detected, not averaged away)
//   - coverage (spec dimensions actually evidenced)
//   - citation integrity (entailment pass rate)

import type { Claim, Evidence, Source, Spec, ClaimEdge } from "./store.ts";
import type { AuditReport } from "./audits.ts";

export interface ResearchMetrics {
	sources: number;
	independentPublishers: number;
	evidenceRecords: number;
	claims: number;
	claimsCitationReady: number;
	/** Claims supported by evidence from >=2 distinct publishers — §10 minimum_independent_support. */
	corroboratedClaims: number;
	corroboratedFraction: number;
	contradictionsDetected: number;
	contradictionsAcknowledged: boolean;
	dimensionsCovered: number;
	dimensionsTotal: number;
	citationPassRate: number; // 1 - failures/checked
	publisherConcentration: number; // max publisher share (lower = more diverse)
}

export function computeMetrics(
	spec: Spec,
	sources: Source[],
	evidence: Evidence[],
	claims: Claim[],
	edges: ClaimEdge[],
	audit: AuditReport,
): ResearchMetrics {
	const publishers = new Map<string, number>();
	for (const s of sources) {
		const p = s.publisher ?? "unknown";
		publishers.set(p, (publishers.get(p) ?? 0) + 1);
	}
	const independentPublishers = publishers.size;
	const publisherConcentration =
		sources.length > 0 ? Math.max(0, ...publishers.values()) / sources.length : 0;

	// publisher lookup per source
	const sourcePublisher = new Map(sources.map((s) => [s.id, s.publisher ?? "unknown"]));

	let corroborated = 0;
	for (const c of claims) {
		const pubs = new Set(c.source_ids.map((sid) => sourcePublisher.get(sid)).filter(Boolean) as string[]);
		if (pubs.size >= 2) corroborated++;
	}
	const citationReady = claims.filter((c) => c.citation_ready).length;

	const contradictions = edges.filter((e) => e.relation === "contradicts");
	const citationChecked = audit.citation_audit.checked;
	const citationFailures = audit.citation_audit.failures.length;

	return {
		sources: sources.length,
		independentPublishers,
		evidenceRecords: evidence.length,
		claims: claims.length,
		claimsCitationReady: citationReady,
		corroboratedClaims: corroborated,
		corroboratedFraction: claims.length > 0 ? corroborated / claims.length : 0,
		contradictionsDetected: contradictions.length,
		contradictionsAcknowledged: audit.contradiction_audit.acknowledged,
		dimensionsCovered: audit.coverage.covered.length,
		dimensionsTotal: audit.coverage.covered.length + audit.coverage.uncovered.length,
		citationPassRate: citationChecked > 0 ? 1 - citationFailures / citationChecked : 1,
		publisherConcentration,
	};
}

/** Format metrics as a compact comparison row. */
export function metricsRow(name: string, m: ResearchMetrics): string {
	return [
		name.padEnd(28),
		String(m.sources).padStart(4),
		String(m.independentPublishers).padStart(4),
		String(m.evidenceRecords).padStart(5),
		String(m.claims).padStart(5),
		String(m.corroboratedClaims).padStart(5),
		`${(m.corroboratedFraction * 100).toFixed(0)}%`.padStart(5),
		String(m.contradictionsDetected).padStart(5),
		`${m.dimensionsCovered}/${m.dimensionsTotal}`.padStart(6),
		`${(m.citationPassRate * 100).toFixed(0)}%`.padStart(5),
		`${(m.publisherConcentration * 100).toFixed(0)}%`.padStart(5),
	].join(" ");
}

export const METRICS_HEADER =
	"config".padEnd(28) +
	" src pub evid  clms corr cor% contr  cov  cit conc";
