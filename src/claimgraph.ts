// src/claimgraph.ts — claim graph, contradiction detection, confidence (§11/12/19).
//
// Evidence units are grouped into canonical claims; claims get edges
// (supports/contradicts/qualifies/duplicate/derived); confidence is a logistic
// over source-quality features — NOT the model's own stated probability.

import type { Evidence, Source, Claim, ClaimEdge } from "./store.ts";

/** Build provisional clusters from exact keys; use lexical fallback only for legacy slotless evidence. */
export function clusterClaims(evidence: Evidence[]): Evidence[][] {
	const clusters: Evidence[][] = [];
	const used = new Set<string>();
	const tokenSets = evidence.map((e) => tokenSet(e.claim));

	for (let i = 0; i < evidence.length; i++) {
		if (used.has(evidence[i].id)) continue;
		const cluster = [evidence[i]];
		used.add(evidence[i].id);

		for (let j = i + 1; j < evidence.length; j++) {
			if (used.has(evidence[j].id)) continue;
			const keyA = evidence[i].proposition_key;
			const keyB = evidence[j].proposition_key;
			const sameKey = !!keyA && !!keyB && normalizePropositionKey(keyA) === normalizePropositionKey(keyB);
			const slotlessFallback = !parsePropositionKey(keyA) && !parsePropositionKey(keyB) && (
				jaccard(tokenSets[i], tokenSets[j]) >= 0.25 ||
				(jaccard(tokenSets[i], tokenSets[j]) >= 0.15 && sharedValueKey(evidence[i], evidence[j])) ||
				sharesEntityAndValue(evidence[i].claim, evidence[j].claim)
			);
			if (!(sameKey || slotlessFallback) || cluster.some((member) => hasHardClaimConflict(member, evidence[j]))) continue;
			cluster.push(evidence[j]);
			used.add(evidence[j].id);
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

export interface PropositionSlots {
	subject: string;
	predicate: string;
	valueUnit: string;
	scopeDate: string;
}

/** Parse the extractor's source-independent four-slot claim identity. */
export function parsePropositionKey(key?: string): PropositionSlots | null {
	if (!key) return null;
	const slots = normalizePropositionKey(key).split("|");
	if (slots.length !== 4) return null;
	const [subject, predicate, valueUnit, scopeDate] = slots;
	return { subject, predicate, valueUnit, scopeDate };
}

/** Reject merges with incompatible value, unit, date, scope, condition, or polarity facts. */
export function hasHardClaimConflict(a: Evidence, b: Evidence): boolean {
	const slotsA = parsePropositionKey(a.proposition_key);
	const slotsB = parsePropositionKey(b.proposition_key);
	if (!slotsA || !slotsB) return false;

	const valuesA = numericSignature(slotsA.valueUnit);
	const valuesB = numericSignature(slotsB.valueUnit);
	if (valuesA.length && valuesB.length && !arraysEqual(valuesA, valuesB)) return true;

	const unitA = unitSignature(slotsA.valueUnit);
	const unitB = unitSignature(slotsB.valueUnit);
	if (valuesA.length && valuesB.length && unitA && unitB && unitA !== unitB) return true;

	const datesA = dateSignature(`${slotsA.scopeDate} ${a.conditions ?? ""}`);
	const datesB = dateSignature(`${slotsB.scopeDate} ${b.conditions ?? ""}`);
	if (datesA.length && datesB.length && !arraysEqual(datesA, datesB)) return true;

	if (mapConflicts(scopeFacts(`${slotsA.scopeDate} ${a.conditions ?? ""}`), scopeFacts(`${slotsB.scopeDate} ${b.conditions ?? ""}`))) return true;
	if (mapConflicts(conditionFacts(a.conditions), conditionFacts(b.conditions))) return true;

	const conditionValuesA = numericSignature(stripDates(a.conditions ?? ""));
	const conditionValuesB = numericSignature(stripDates(b.conditions ?? ""));
	if (conditionValuesA.length && conditionValuesB.length && !arraysEqual(conditionValuesA, conditionValuesB)) return true;

	return polarity(`${slotsA.predicate} ${a.claim}`) !== polarity(`${slotsB.predicate} ${b.claim}`);
}

/** Source-agnostic blocking for provisional cluster pairs worth a relation check. */
export function claimClusterCandidates(clusters: Evidence[][]): Array<[number, number]> {
	const blocks = new Map<string, number[]>();
	for (let i = 0; i < clusters.length; i++) {
		const keys = new Set(clusters[i].flatMap(blockingKeys));
		for (const key of keys) blocks.set(key, [...(blocks.get(key) ?? []), i]);
	}
	const pairKeys = new Set<string>();
	for (const members of blocks.values()) {
		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) pairKeys.add(pairKey(members[i], members[j]));
		}
	}
	return [...pairKeys]
		.map((key) => key.split(":").map(Number) as [number, number])
		.filter(([a, b]) =>
			clustersSlotCompatible(clusters[a], clusters[b]) || clustersDescribeSameMetric(clusters[a], clusters[b]),
		)
		.sort(([a1, b1], [a2, b2]) => a1 - a2 || b1 - b2);
}

/** Complete-link reducer: every cross-member pair must be compatible and classified duplicate. */
export function coalesceClaimClusters(
	clusters: Evidence[][],
	duplicatePairs: ReadonlyArray<readonly [number, number]>,
): Evidence[][] {
	const duplicateKeys = new Set(duplicatePairs.map(([a, b]) => pairKey(a, b)));
	const groups = clusters.map((_, i) => [i]);

	for (const [left, right] of duplicatePairs) {
		const leftGroup = groups.findIndex((group) => group.includes(left));
		const rightGroup = groups.findIndex((group) => group.includes(right));
		if (leftGroup < 0 || rightGroup < 0 || leftGroup === rightGroup) continue;
		const completeLink = groups[leftGroup].every((a) =>
			groups[rightGroup].every((b) => duplicateKeys.has(pairKey(a, b)) && clustersSlotCompatible(clusters[a], clusters[b])),
		);
		if (!completeLink) continue;
		const keep = Math.min(leftGroup, rightGroup);
		const drop = Math.max(leftGroup, rightGroup);
		groups[keep] = [...groups[keep], ...groups[drop]].sort((a, b) => a - b);
		groups.splice(drop, 1);
	}

	return groups
		.sort((a, b) => a[0] - b[0])
		.map((group) => group.flatMap((i) => clusters[i]));
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
	propositionA?: string;
	propositionB?: string;
}

/** Relation input for provisional clusters before final Claim construction. */
export function clusterRelationInput(a: Evidence[], b: Evidence[]): RelationContext {
	const representativeA = [...a].sort((x, y) => y.confidence - x.confidence)[0];
	const representativeB = [...b].sort((x, y) => y.confidence - x.confidence)[0];
	return {
		claimA: representativeA?.claim ?? "",
		claimB: representativeB?.claim ?? "",
		evidenceA: a.map((e) => e.id),
		evidenceB: b.map((e) => e.id),
		conditionsA: unique(a.map((e) => e.conditions).filter(Boolean) as string[]).join("; ") || undefined,
		conditionsB: unique(b.map((e) => e.conditions).filter(Boolean) as string[]).join("; ") || undefined,
		propositionA: representativeA?.proposition_key,
		propositionB: representativeB?.proposition_key,
	};
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

/** Lexical proximity used to spend bounded relation checks on related claims. */
export function claimTextSimilarity(a: string, b: string): number {
	return jaccard(tokenSet(a), tokenSet(b));
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
function blockingKeys(evidence: Evidence): string[] {
	const slots = parsePropositionKey(evidence.proposition_key);
	if (!slots) return [];
	const keys = [
		...slotTokens(slots.subject).map((token) => `subject:${token}`),
		...slotTokens(slots.predicate).map((token) => `predicate:${token}`),
		...slotTokens(stripDates(slots.scopeDate)).map((token) => `scope:${token}`),
		...dateSignature(slots.scopeDate).map((date) => `date:${date}`),
	];
	const subjectAcronym = slotTokens(slots.subject).map((token) => token[0]).join("");
	if (subjectAcronym.length > 1) keys.push(`subject:${subjectAcronym}`);
	const values = numericSignature(slots.valueUnit);
	if (values.length) keys.push(`value:${values.join(",")}:${unitSignature(slots.valueUnit)}`);
	else if (slots.valueUnit !== "none") keys.push(`value:${slotTokens(slots.valueUnit).join(" ")}`);
	return keys;
}

function clustersSlotCompatible(a: Evidence[], b: Evidence[]): boolean {
	if (a.some((left) => b.some((right) => hasHardClaimConflict(left, right)))) return false;
	return a.some((left) => b.some((right) => evidenceSlotCompatible(left, right)));
}

/** Related subject+predicate pairs still need relation checks when their values conflict. */
function clustersDescribeSameMetric(a: Evidence[], b: Evidence[]): boolean {
	return a.some((left) => b.some((right) => {
		const slotsA = parsePropositionKey(left.proposition_key);
		const slotsB = parsePropositionKey(right.proposition_key);
		if (left.source_id === right.source_id) return false;
		return !!slotsA && !!slotsB &&
			slotsMostlyRelated(slotsA.subject, slotsB.subject) && slotsMostlyRelated(slotsA.predicate, slotsB.predicate);
	}));
}

function evidenceSlotCompatible(a: Evidence, b: Evidence): boolean {
	const slotsA = parsePropositionKey(a.proposition_key);
	const slotsB = parsePropositionKey(b.proposition_key);
	if (!slotsA || !slotsB || hasHardClaimConflict(a, b)) return false;
	const valuesA = numericSignature(slotsA.valueUnit);
	const valuesB = numericSignature(slotsB.valueUnit);
	const sameValue = (valuesA.length > 0 && arraysEqual(valuesA, valuesB)) || slotsRelated(slotsA.valueUnit, slotsB.valueUnit);
	const sameSubject = slotsRelated(slotsA.subject, slotsB.subject);
	const samePredicate = slotsRelated(slotsA.predicate, slotsB.predicate);
	const sameScope = slotsRelated(stripDates(slotsA.scopeDate), stripDates(slotsB.scopeDate));
	const datesA = dateSignature(slotsA.scopeDate);
	const datesB = dateSignature(slotsB.scopeDate);
	const sameDate = datesA.length > 0 && arraysEqual(datesA, datesB);
	return (sameValue && (sameSubject || samePredicate || sameScope || sameDate)) || (sameSubject && samePredicate) || (samePredicate && sameScope);
}

function slotsRelated(a: string, b: string): boolean {
	if (!a || !b || a === "none" || b === "none") return false;
	if (a === b) return true;
	const tokensA = slotTokens(a);
	const tokensB = slotTokens(b);
	if (tokensA.some((token) => tokensB.includes(token))) return true;
	const acronymA = tokensA.map((token) => token[0]).join("");
	const acronymB = tokensB.map((token) => token[0]).join("");
	return (acronymA.length > 1 && tokensB.includes(acronymA)) || (acronymB.length > 1 && tokensA.includes(acronymB));
}

function slotsMostlyRelated(a: string, b: string): boolean {
	const tokensA = new Set(slotTokens(a));
	const tokensB = new Set(slotTokens(b));
	if (tokensA.size === 0 || tokensB.size === 0) return false;
	let shared = 0;
	for (const token of tokensA) if (tokensB.has(token)) shared++;
	// ponytail: cheap blocker only; the relation model makes the semantic decision.
	return shared / (tokensA.size + tokensB.size - shared) >= 0.5;
}

function slotTokens(s: string): string[] {
	const stop = new Set(["a", "an", "and", "for", "in", "of", "the", "to"]);
	return s.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !stop.has(token)) ?? [];
}

function numericSignature(s: string): string[] {
	const scales: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, bn: 1e9 };
	const values: number[] = [];
	for (const match of s.replace(/(\d),(?=\d)/g, "$1").matchAll(/-?\d+(?:\.\d+)?(?:\s*(thousand|million|billion|trillion|bn))?/gi)) {
		values.push(Number(match[0].match(/-?\d+(?:\.\d+)?/)![0]) * (scales[match[1]?.toLowerCase()] ?? 1));
	}
	return values.sort((a, b) => a - b).map(String);
}

function unitSignature(s: string): string {
	return s
		.toLowerCase()
		.replace(/\$/g, " usd ")
		.replace(/€/g, " eur ")
		.replace(/£/g, " gbp ")
		.replace(/\b(?:us|u\.s\.)\s+dollars?\b|\bdollars?\b/g, "usd")
		.replace(/\bpercent\b/g, "%")
		.replace(/\bper\b/g, "/")
		.replace(/\bkilowatt[- ]hours?\b/g, "kwh")
		.replace(/\bmegawatt[- ]hours?\b/g, "mwh")
		.replace(/\bkilowatts?\b/g, "kw")
		.replace(/\bmegawatts?\b/g, "mw")
		.replace(/-?\d+(?:[,.]\d+)*(?:\s*(?:thousand|million|billion|trillion|bn))?/g, "")
		.replace(/\b(?:about|approximately|approx|around|estimated|roughly)\b/g, "")
		.replace(/[^a-z%/]/g, "");
}

function dateSignature(s: string): string[] {
	const dates = new Set<string>();
	const specificYears = new Set<string>();
	for (const match of s.toLowerCase().matchAll(/\b((?:18|19|20|21)\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\b/g)) {
		dates.add(`${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);
		specificYears.add(match[1]);
	}
	for (const match of s.toLowerCase().matchAll(/\b((?:18|19|20|21)\d{2})\s*(?:q([1-4])|quarter\s*([1-4]))\b/g)) {
		dates.add(`${match[1]}-q${match[2] ?? match[3]}`);
		specificYears.add(match[1]);
	}
	for (const match of s.matchAll(/\b(?:18|19|20|21)\d{2}\b/g)) if (!specificYears.has(match[0])) dates.add(match[0]);
	return [...dates].sort();
}

function stripDates(s: string): string {
	return s.replace(/\b(?:18|19|20|21)\d{2}(?:-\d{1,2}(?:-\d{1,2})?)?\b/g, " ");
}

function scopeFacts(s: string): Map<string, string> {
	const normalized = s.toLowerCase().replace(/[._-]+/g, " ");
	const facts = new Map<string, string>();
	const groups: Array<[string, Array<[string, RegExp]>]> = [
		["geography", [["global", /\b(?:global|worldwide|world)\b/], ["us", /\b(?:united states|usa|us)\b/], ["canada", /\bcanada\b/], ["europe", /\b(?:europe|eu|european union)\b/], ["uk", /\b(?:united kingdom|uk)\b/], ["china", /\bchina\b/], ["india", /\bindia\b/], ["australia", /\baustralia\b/]]],
		["maturity", [["foak", /\b(?:foak|first of a kind|first commercial)\b/], ["noak", /\b(?:noak|nth of a kind|mature fleet)\b/], ["pilot", /\b(?:pilot|demonstration)\b/]]],
		["scenario", [["base", /\b(?:base|baseline|central)\b/], ["optimistic", /\boptimistic\b/], ["conservative", /\bconservative\b/]]],
		["setting", [["onshore", /\bonshore\b/], ["offshore", /\boffshore\b/], ["residential", /\bresidential\b/], ["commercial", /\bcommercial\b/], ["industrial", /\bindustrial\b/]]],
	];
	for (const [category, variants] of groups) {
		const found = variants.find(([, pattern]) => pattern.test(normalized));
		if (found) facts.set(category, found[0]);
	}
	return facts;
}

function conditionFacts(s?: string): Map<string, string> {
	const facts = new Map<string, string>();
	if (!s) return facts;
	for (const match of s.toLowerCase().matchAll(/\b([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,2})\s*[:=]\s*([^;,|]+)/g)) {
		facts.set(
			match[1].replace(/[_\s]+/g, " ").trim(),
			match[2].replace(/\bpercent\b/g, "%").replace(/\s*%/g, "%").replace(/\s+/g, " ").trim(),
		);
	}
	return facts;
}

function mapConflicts(a: Map<string, string>, b: Map<string, string>): boolean {
	for (const [key, value] of a) {
		const other = b.get(key);
		if (other !== undefined && other !== value) return true;
	}
	return false;
}

function polarity(s: string): string {
	if (/\b(?:cannot|can't|didn't|doesn't|isn't|never|no|not|wasn't|without|won't)\b|\b(?:exclude|excludes|excluded|excluding)\b/i.test(s)) return "negative";
	if (/\b(?:decrease|decreased|decline|declined|fall|fell|lowered)\b/i.test(s)) return "decrease";
	if (/\b(?:increase|increased|rise|rose|raised)\b/i.test(s)) return "increase";
	return "positive";
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

function pairKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

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
