// src/claimgraph.ts — claim graph, contradiction detection, confidence (§11/12/19).
//
// Evidence units are grouped into canonical claims; claims get edges
// (supports/contradicts/qualifies/duplicate/derived); confidence is a logistic
// over source-quality features — NOT the model's own stated probability.

import type { Evidence, Source, Claim, ClaimEdge } from "./store.ts";

/** Group atomic evidence into canonical claims by proposition key, then semantic similarity. */
export function clusterClaims(evidence: Evidence[]): Evidence[][] {
	const clusters: Evidence[][] = [];
	const used = new Set<string>();
	const tokenSets = evidence.map((e) => tokenSet(e.claim));

	// First pass: cluster by exact proposition_key match (semantic canonicalization)
	const keyGroups = new Map<string, Evidence[]>();
	for (const e of evidence) {
		if (e.proposition_key) {
			const key = normalizePropositionKey(e.proposition_key);
			if (!keyGroups.has(key)) keyGroups.set(key, []);
			keyGroups.get(key)!.push(e);
		}
	}

	for (let i = 0; i < evidence.length; i++) {
		if (used.has(evidence[i].id)) continue;
		const cluster = [evidence[i]];
		used.add(evidence[i].id);

		// If this evidence has a proposition_key, merge all evidence with the same key
		const pk = evidence[i].proposition_key;
		if (pk) {
			const key = normalizePropositionKey(pk);
			for (const other of (keyGroups.get(key) ?? [])) {
				if (other.id !== evidence[i].id && !used.has(other.id)) {
					cluster.push(other);
					used.add(other.id);
				}
			}
		}

		// Fallback: lexical similarity for evidence without proposition_key matches
		for (let j = i + 1; j < evidence.length; j++) {
			if (used.has(evidence[j].id)) continue;
			const sim = jaccard(tokenSets[i], tokenSets[j]);
			const sameMetric = sharedValueKey(evidence[i], evidence[j]);
			const sameEntityValue = sharesEntityAndValue(evidence[i].claim, evidence[j].claim);
			if (sim >= 0.25 || (sim >= 0.15 && sameMetric) || sameEntityValue) {
				cluster.push(evidence[j]);
				used.add(evidence[j].id);
			}
		}
		clusters.push(cluster);
	}
	return clusters;
}

function normalizePropositionKey(key: string): string {
	return key
		.toLowerCase()
		.split("|")
		.map((slot) => slot.trim().replace(/\s+/g, " ").replace(/(\d),(?=\d)/g, "$1"))
		.join("|");
}

export type ClaimRelation = "supports" | "contradicts" | "qualifies" | "duplicate" | "derived" | "unrelated";

/** Context for a contradiction check — the model reasons over condition compatibility. */
export interface RelationContext {
	claimA: string;
	claimB: string;
	evidenceA: string[];
	evidenceB: string[];
	conditionsA?: string;
	conditionsB?: string;
}

/**
 * Confidence estimation (§19). A defensible score uses evidence features, not
 * the model's self-reported probability. Weights chosen to reward independent
 * corroboration and penalize unresolved contradiction.
 *
 *   Confidence = σ(w1·N_indep + w2·Q_sources + w3·D_directness
 *                 + w4·consistency + w5·recency
 *                 − w6·contradiction − w7·assumptionSensitivity)
 */
export function estimateConfidence(args: {
	independentSources: number;
	meanSourceQuality: number; // 0..1
	meanDirectness: number; // 0..1
	consistency: number; // 0..1 agreement fraction
	recency: number; // 0..1
	contradictionStrength: number; // 0..1
	assumptionSensitivity: number; // 0..1
}): { confidence: number; label: string } {
	const w = { n: 0.55, q: 0.8, d: 0.4, c: 0.9, r: 0.3, contra: 1.4, asmp: 0.5 };
	const z =
		w.n * Math.log1p(args.independentSources) +
		w.q * args.meanSourceQuality +
		w.d * args.meanDirectness +
		w.c * args.consistency +
		w.r * args.recency -
		w.contra * args.contradictionStrength -
		w.asmp * args.assumptionSensitivity;
	const confidence = 1 / (1 + Math.exp(-z));
	let label: string;
	if (args.contradictionStrength > 0.6) label = "contested";
	else if (confidence > 0.75) label = "high";
	else if (confidence > 0.5) label = "moderate";
	else if (confidence > 0.3) label = "low";
	else label = "unknown";
	return { confidence, label };
}

/** Build a Claim record from a cluster of evidence. */
export function buildClaim(id: string, cluster: Evidence[], sources: Source[]): Claim {
	const sourceIds = new Set(cluster.map((e) => e.source_id));
	const supporting = cluster.filter((e) => e.confidence >= 0.5);
	const contradicting = cluster.filter((e) => e.confidence < 0.3);
	// canonical text = the highest-confidence claim wording
	const canonical = [...cluster].sort((a, b) => b.confidence - a.confidence)[0]?.claim ?? cluster[0]?.claim ?? "";
	const consistencies = supporting.length / Math.max(1, cluster.length);
	const qualities = cluster.map((e) => {
		const s = sources.find((x) => x.id === e.source_id);
		return s ? qualityToScore(s.quality) : 0.5;
	});
	const { confidence, label } = estimateConfidence({
		independentSources: sourceIds.size,
		meanSourceQuality: avg(qualities),
		meanDirectness: 0.7,
		consistency: consistencies,
		recency: 0.7,
		contradictionStrength: contradicting.length / Math.max(1, cluster.length),
		assumptionSensitivity: cluster.filter((e) => e.conditions && /assum|forecast|estimat|project/i.test(e.conditions)).length / Math.max(1, cluster.length),
	});
	return {
		id,
		text: canonical,
		status: label,
		supporting_evidence: supporting.map((e) => e.id),
		contradicting_evidence: contradicting.map((e) => e.id),
		assumptions: unique(cluster.map((e) => e.conditions).filter(Boolean) as string[]).slice(0, 5),
		confidence,
		citation_ready: confidence >= 0.4 && supporting.length >= 1,
		evidence_ids: cluster.map((e) => e.id),
		source_ids: [...sourceIds],
	};
}

/** Compute pairwise edges between claims via the model (relation classification). */
export function edgeCandidates(claims: Claim[]): Array<[Claim, Claim]> {
	const out: Array<[Claim, Claim]> = [];
	for (let i = 0; i < claims.length; i++)
		for (let j = i + 1; j < claims.length; j++) out.push([claims[i], claims[j]]);
	return out;
}

/** Serialize an edge into an LLM-friendly relation-check input. */
export function relationInput(a: Claim, b: Claim): RelationContext {
	return {
		claimA: a.text,
		claimB: b.text,
		evidenceA: a.supporting_evidence,
		evidenceB: b.supporting_evidence,
		conditionsA: a.assumptions.join("; "),
		conditionsB: b.assumptions.join("; "),
	};
}

/** Parse the model's relation label into a ClaimEdge. Caller filters "unrelated". */
export function toEdge(aId: string, bId: string, relation: ClaimRelation): ClaimEdge {
	return { from: aId, to: bId, relation: relation as import("./store.ts").ClaimRelation };
}

// ── helpers ──────────────────────────────────────────────────────────────
function tokenSet(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/[^a-z0-9\s.%/]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 2),
	);
}
function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/** Two claims quoting the same metric key are likely the same proposition. */
function sharedValueKey(a: Evidence, b: Evidence): boolean {
	const ka = Object.keys(a.values ?? {});
	if (ka.length === 0) return false;
	const kb = new Set(Object.keys(b.values ?? {}));
	return ka.some((k) => kb.has(k));
}

/** §9.2 entity+value canonicalization: do two claim texts share a significant entity AND a numeric value? */
export function sharesEntityAndValue(textA: string, textB: string): boolean {
	if (!textA || !textB) return false;
	const entA = extractEntitiesFromText(textA);
	const entB = extractEntitiesFromText(textB);
	if (entA.size === 0) return false;
	const sharedEntity = [...entA].some((e) => entB.has(e));
	if (!sharedEntity) return false;
	const valA = extractNumbersFromText(textA);
	const valB = extractNumbersFromText(textB);
	if (valA.length === 0 || valB.length === 0) return false;
	return valA.some((v) => valB.some((ov) => Math.abs(v - ov) / Math.max(v, ov, 1) < 0.1));
}

function extractEntitiesFromText(text: string): Set<string> {
	const s = new Set<string>();
	if (!text) return s;
	for (const m of text.matchAll(/\b([A-Z][a-z]{3,}|[A-Z]{2,}\d*|[A-Z]{2,}-\d+)\b/g)) s.add(m[1].toLowerCase());
	return s;
}
function extractNumbersFromText(text: string): number[] {
	if (!text) return [];
	const out: number[] = [];
	for (const m of text.matchAll(/(\d[\d,.]*)/g)) {
		const n = Number(m[1].replace(/,/g, ""));
		if (!Number.isNaN(n) && n > 100) out.push(n);
	}
	return out;
}
function avg(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function unique<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}
function qualityToScore(q: Source["quality"]): number {
	return q === "high" ? 0.85 : q === "medium" ? 0.6 : q === "low" ? 0.35 : 0.5;
}
