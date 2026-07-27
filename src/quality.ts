// src/quality.ts — source-quality assessment (§10).
//
// Quality is a feature vector, not a boolean. Computed heuristically at ingest
// time (zero extra model calls): authority from TLD/publisher, recency from the
// document date, provenance from content type, transparency from methodology
// markers, independence/COI from vendor-name overlap with the topic.

import type { SourceQualityFeatures } from "./store.ts";

export interface QualityInput {
	url: string;
	title: string;
	contentType: string;
	kind: "html" | "pdf" | "text";
	text: string;
	date?: string;
	topicKeywords: string[]; // from the spec (vendor/product names show COI)
}

export function assessSourceQuality(input: QualityInput): SourceQualityFeatures {
	const host = hostOf(input.url);
	return {
		institutional_authority: authorityScore(host),
		methodological_transparency: transparencyScore(input.text),
		data_provenance: provenanceScore(input),
		independence: independenceScore(host, input.topicKeywords),
		recency: recencyScore(input.date),
		domain_relevance: relevanceScore(input),
		conflict_of_interest_risk: coiScore(host, input.topicKeywords),
	};
}

/** Composite score Q_s = Σ w_i f_i (§10). COI risk counts against. */
export function compositeQuality(f: SourceQualityFeatures): number {
	return (
		0.25 * f.institutional_authority +
		0.15 * f.methodological_transparency +
		0.15 * f.data_provenance +
		0.15 * f.independence +
		0.1 * f.recency +
		0.2 * f.domain_relevance -
		0.25 * f.conflict_of_interest_risk
	);
}

export function qualityLabel(composite: number): "high" | "medium" | "low" {
	return composite >= 0.62 ? "high" : composite >= 0.42 ? "medium" : "low";
}

// ── feature scorers (each 0..1) ──────────────────────────────────────────
function authorityScore(host: string): number {
	if (/\.gov\b|\.gouv\.|\.gov\.[a-z]{2}$/.test(host)) return 0.95;
	if (/\.edu\b|\.ac\.[a-z]{2}$/.test(host)) return 0.9;
	if (/^(www\.)?(nrc|osti|energy|eia|iea|oecd|iaea|world-nuclear)\./.test(host)) return 0.9;
	if (/\.org\b/.test(host)) return 0.7;
	if (/wikipedia\.org/.test(host)) return 0.55;
	if (/reuters\.com|apnews\.com|ft\.com|wsj\.com|economist\.com/.test(host)) return 0.75;
	return 0.5;
}

function transparencyScore(text: string): number {
	const markers = (text.match(/methodolog|assumption|estimat|uncertain|confidence interval|monte carlo|sensitivity analysis/gi) ?? []).length;
	return Math.min(1, 0.3 + markers * 0.12);
}

function provenanceScore(input: QualityInput): number {
	let s = input.kind === "pdf" ? 0.8 : 0.55;
	if (/\b\d{4}\b/.test(input.text)) s += 0.05; // cites years
	if (/table|figure|appendix/i.test(input.text)) s += 0.1; // structured data
	return Math.min(1, s);
}

function independenceScore(host: string, topicKeywords: string[]): number {
	// a vendor writing about its own product is not independent
	const hostTokens = host.replace(/\.(com|org|gov|edu|net)$/, "").split(/[.-]/);
	for (const kw of topicKeywords) {
		const kwTokens = kw.toLowerCase().split(/\s+/);
		if (kwTokens.some((t) => t.length > 3 && hostTokens.some((h) => h.includes(t)))) return 0.3;
	}
	return 0.65;
}

function coiScore(host: string, topicKeywords: string[]): number {
	return 1 - independenceScore(host, topicKeywords);
}

function recencyScore(date?: string): number {
	if (!date) return 0.5;
	const year = Number(String(date).slice(0, 4));
	if (Number.isNaN(year)) return 0.5;
	const age = new Date().getFullYear() - year;
	if (age <= 0) return 1;
	if (age === 1) return 0.9;
	if (age === 2) return 0.75;
	if (age <= 4) return 0.55;
	return 0.35;
}

function relevanceScore(input: QualityInput): number {
	// crude: fraction of topic keywords present in title+first 2k chars
	const hay = (input.title + " " + input.text.slice(0, 2000)).toLowerCase();
	if (input.topicKeywords.length === 0) return 0.5;
	const hits = input.topicKeywords.filter((k) => hay.includes(k.toLowerCase())).length;
	return Math.min(1, 0.3 + (hits / input.topicKeywords.length) * 0.7);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}
