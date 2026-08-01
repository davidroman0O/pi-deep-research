// src/metrics.ts — research-quality metrics that actually matter.
//
// Line count is vanity. These measure whether the research is *better*:
//   - source plurality (how many distinct publishers)
//   - independent corroboration (claims backed by >=2 different publishers)
//   - contradiction surfacing (was disagreement detected, not averaged away)
//   - coverage (spec dimensions actually evidenced)
//   - citation integrity (entailment pass rate)

import { detectSourceFamily } from "./novel.ts";
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

	// source-family lookup for syndication-aware independence (DRH C4)
	const sourceFamily = new Map(sources.map((s) => [s.id, s.source_family ?? detectSourceFamily(s.url, s.publisher ?? "unknown")]));

	// §9.2 corroboration-aware matching: two claims corroborate if they're from
	// different families AND share a significant entity + a numeric value (within
	// tolerance). This catches differently-worded claims about the same fact —
	// e.g. "$20,139/kW FOAK" from s3 and "unit cost increased to $20,139/kW" from s6.
	// Text jaccard alone misses these; entity+value matching is the §9.2 canonicalization.
	let corroborated = 0;
	for (const c of claims) {
		const claimEvidence = evidence.filter((e) => c.evidence_ids.includes(e.id));
		const families = new Set(
			claimEvidence.map((e) => sourceFamily.get(e.source_id)).filter(Boolean) as string[],
		);
		if (families.size >= 2) {
			corroborated++;
			continue;
		}
		// A model-classified supports edge is independent corroboration when
		// its other endpoint comes from a different source family.
		const graphSupported = edges.some((edge) => {
			if (edge.relation !== "supports") return false;
			const otherId = edge.from === c.id ? edge.to : edge.to === c.id ? edge.from : undefined;
			const other = claims.find((candidate) => candidate.id === otherId);
			if (!other) return false;
			const otherFamilies = new Set(
				evidence
					.filter((e) => other.evidence_ids.includes(e.id))
					.map((e) => sourceFamily.get(e.source_id))
					.filter(Boolean) as string[],
			);
			return [...otherFamilies].some((family) => !families.has(family));
		});
		if (graphSupported) {
			corroborated++;
			continue;
		}
		// fallback: entity+value matching across ALL evidence (not just this claim's)
		// if another claim from a different family shares entity + value → corroborated
		const cEntities = extractEntities(c.text);
		const cValues = extractValues(c.text);
		// Keep explicit sub-100 values (percentages, $/MWh, small capacities)
		// scoped by proposition subject/predicate + unit so years and unrelated metrics cannot collide.
		const cScopedValues = extractScopedValues(c.text);
		const cScopes = propositionScopes(claimEvidence);
		if ((cEntities.size > 0 && cValues.length > 0) || (cScopes.length > 0 && cScopedValues.length > 0)) {
			for (const other of claims) {
				if (other.id === c.id) continue;
				const otherEvidence = evidence.filter((e) => other.evidence_ids.includes(e.id));
				const otherFamilies = new Set(
					otherEvidence.map((e) => sourceFamily.get(e.source_id)).filter(Boolean) as string[],
				);
				// must have at least one family different from c's
				const hasDifferentFamily = [...otherFamilies].some((f) => !families.has(f));
				if (!hasDifferentFamily) continue;
				const oEntities = extractEntities(other.text);
				const oValues = extractValues(other.text);
				const sharedEntity = [...cEntities].some((e) => oEntities.has(e));
				const sharedValue = cValues.some((v) => oValues.some((ov) => Math.abs(v - ov) / Math.max(v, ov, 1) < 0.1));
				const oScopedValues = extractScopedValues(other.text);
				const sharedScopedValue = cScopedValues.some((v) =>
					oScopedValues.some((ov) => v.unit === ov.unit && Math.abs(v.amount - ov.amount) / Math.max(v.amount, ov.amount, 1) < 0.1),
				);
				const sharedScope = cScopes.some((a) => propositionScopes(otherEvidence).some((b) =>
					slotsRelated(a.subject, b.subject) && slotsRelated(a.predicate, b.predicate),
				));
				if ((sharedEntity && sharedValue) || (sharedScope && sharedScopedValue)) {
					corroborated++;
					break;
				}
			}
		}
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

/** Extract significant entities from a claim (capitalized words, acronyms). */
function extractEntities(text: string): Set<string> {
	const entities = new Set<string>();
	for (const m of text.matchAll(/\b([A-Z][a-z]{3,}|[A-Z]{2,}\d*|[A-Z]{2,}-\d+)\b/g)) {
		entities.add(m[1].toLowerCase());
	}
	return entities;
}

/** Extract numeric values from a claim (strip formatting, parse to number). */
function extractValues(text: string): number[] {
	const values: number[] = [];
	for (const m of text.matchAll(/(?:\$|€|£|CAD|USD)?\s?(\d[\d,.]*)\s*(?:\/kW\w*|\/MWh|bn|billion|million|%|MW\w*|kW\w*)?/gi)) {
		const raw = m[1].replace(/,/g, "");
		const n = Number(raw);
		if (!Number.isNaN(n) && n > 100) values.push(n);
	}
	return values;
}

interface ScopedValue {
	amount: number;
	unit: string;
}

/** Extract explicit-unit values for proposition-scoped corroboration. */
function extractScopedValues(text: string): ScopedValue[] {
	const values: ScopedValue[] = [];
	for (const m of text.matchAll(/(\$|€|£|CAD|USD)?\s?(\d[\d,.]*)\s*(\/kW\w*|\/MWh|bn|billion|million|%|MW\w*|kW\w*)?/gi)) {
		const amount = Number(m[2].replace(/,/g, ""));
		if (Number.isNaN(amount) || (!m[1] && !m[3])) continue;
		const currency = (m[1] ?? "").toLowerCase().replace("$", "usd").replace("€", "eur").replace("£", "gbp");
		const suffix = (m[3] ?? "").toLowerCase().replace(/^bn$/, "billion");
		values.push({ amount, unit: currency + suffix });
	}
	return values;
}

interface PropositionScope {
	subject: string;
	predicate: string;
}

function propositionScopes(evidence: Evidence[]): PropositionScope[] {
	return evidence.flatMap((e) => {
		const [subject = "", predicate = ""] = (e.proposition_key ?? "").split("|")
			.map((slot) => slot.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
		return subject && predicate && subject !== "none" && predicate !== "none" ? [{ subject, predicate }] : [];
	});
}

function slotsRelated(a: string, b: string): boolean {
	const aTokens = a.split(" ");
	const bTokens = b.split(" ");
	return aTokens.every((token) => bTokens.includes(token)) || bTokens.every((token) => aTokens.includes(token));
}
