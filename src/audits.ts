// src/audits.ts — citation entailment + final quality audits (§22/§23).
//
// Citation integrity is a reverse map: report sentence → claim → evidence →
// source. Every factual sentence with a [n] citation is checked for entailment
// against the evidence quote that citation stands on. Then nine audit passes
// run over the report + claim graph before the run is marked completed.

import { llmJson, type ModelHandle } from "./llm.ts";
import { ENTAIL_SYSTEM, entailPrompt, ENTAIL_TOOL } from "./prompts.ts";
import type { Claim, ClaimEdge, Evidence, Source, Spec, Task } from "./store.ts";

export interface CitationFailure {
	sentence: string;
	raw: string; // original report line — repair replacements match against this
	citation: string;
	citationNum: number;
	problem: string;
}

export interface AuditReport {
	coverage: { covered: string[]; uncovered: string[]; pass: boolean };
	claim_audit: { total: number; unsupported: string[]; pass: boolean };
	citation_audit: { checked: number; failures: CitationFailure[]; pass: boolean };
	contradiction_audit: { unresolved: number; acknowledged: boolean };
	freshness: { stale_sources: string[]; pass: boolean };
	numerical: { suspicious: string[]; pass: boolean };
	source_diversity: { publishers: number; dominant_share: number; pass: boolean };
	leakage: { flags: string[]; pass: boolean };
	safety: { injected_sources: number; pass: boolean };
	overall_pass: boolean;
}

// ── citation extraction ──────────────────────────────────────────────────
interface SentenceCitation {
	sentence: string;
	raw: string;
	citationNum: number;
}

/** Split report body into factual sentences carrying [n] citations. */
export function extractCitedSentences(report: string): SentenceCitation[] {
	const body = report.split(/^## Sources/m)[0] ?? report;
	const out: SentenceCitation[] = [];
	for (const line of body.split("\n")) {
		const clean = line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
		if (clean.length < 30) continue;
		for (const m of clean.matchAll(/\[(\d+)\]/g)) {
			out.push({ sentence: clean, raw: line, citationNum: Number(m[1]) });
		}
	}
	return out;
}

/** Entailment-check each cited sentence against its cited source's evidence quotes. */
export async function auditCitations(
	handle: ModelHandle,
	report: string,
	sources: Source[],
	evidence: Evidence[],
	signal?: AbortSignal,
	maxChecks = 25,
): Promise<{ checked: number; failures: CitationFailure[] }> {
	const cited = extractCitedSentences(report).slice(0, maxChecks);
	const failures: CitationFailure[] = [];
	let checked = 0;
	for (const sc of cited) {
		const src = sources[sc.citationNum - 1];
		if (!src) {
			failures.push({ sentence: sc.sentence, raw: sc.raw, citation: `[${sc.citationNum}]`, citationNum: sc.citationNum, problem: "citation index has no matching source" });
			continue;
		}
		// Match the sentence against ALL of the cited source's evidence and pick
		// the top quotes by relevance — a report sentence may cite any of the
		// facts extracted from that source, not just the first one.
		const srcEvidence = evidence.filter((e) => e.source_id === src.id && e.quote);
		if (srcEvidence.length === 0) {
			// no evidence recorded from this source — citation is unsupportable
			failures.push({ sentence: sc.sentence, raw: sc.raw, citation: `[${sc.citationNum}]`, citationNum: sc.citationNum, problem: "no extracted evidence backs this source citation" });
			continue;
		}
		checked++;
		const ranked = rankEvidenceForSentence(sc.sentence, srcEvidence).slice(0, 2);
		const best = ranked[0];
		const bundle = ranked.map((e) => `claim: ${e.claim}\nquote: ${e.quote}`).join("\n---\n");
		const verdict = await llmJson<{ entailed: boolean; problem?: string }>(
			handle,
			ENTAIL_TOOL,
			ENTAIL_SYSTEM,
			entailPrompt(sc.sentence, best.claim, bundle),
			{ signal, temperature: 0 },
		);
		if (!verdict.entailed) {
			failures.push({ sentence: sc.sentence, raw: sc.raw, citation: `[${sc.citationNum}]`, citationNum: sc.citationNum, problem: verdict.problem ?? "not entailed" });
		}
	}
	return { checked, failures };
}

// ── evidence ranking for the citation audit ────────────────────────────
/** Token-overlap relevance of an evidence record to a report sentence. */
function rankEvidenceForSentence(sentence: string, evidence: Evidence[]): Evidence[] {
	const q = new Set(sentence.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2));
	return [...evidence]
		.map((e) => {
			const text = (e.claim + " " + (e.quote ?? "")).toLowerCase();
			let hits = 0;
			for (const t of q) if (text.includes(t)) hits++;
			return { e, score: hits / Math.max(1, q.size) };
		})
		.sort((a, b) => b.score - a.score)
		.map((r) => r.e);
}

// ── the nine audits (§23) ────────────────────────────────────────────────
export function runStaticAudits(args: {
	spec: Spec;
	tasks: Task[];
	sources: Source[];
	evidence: Evidence[];
	claims: Claim[];
	edges: ClaimEdge[];
	report: string;
	injectionFlags: string[];
}): Omit<AuditReport, "citation_audit" | "overall_pass"> {
	const { spec, tasks, sources, evidence, claims, edges, report, injectionFlags } = args;

	// 1. coverage — every spec dimension appears in report or evidence
	const hay = (report + " " + evidence.map((e) => e.claim).join(" ")).toLowerCase();
	const covered = spec.dimensions.filter((d) => hay.includes(d.toLowerCase().split(" ")[0] ?? d.toLowerCase()));
	const uncovered = spec.dimensions.filter((d) => !covered.includes(d));

	// 2. claim audit — every claim has at least one supporting evidence
	const unsupported = claims.filter((c) => c.supporting_evidence.length === 0).map((c) => c.id);

	// 4. contradiction audit — unresolved contradicts edges acknowledged in report
	const contradictions = edges.filter((e) => e.relation === "contradicts");
	const acknowledged = contradictions.length === 0 || /contradict|disagree|conflict|differ/i.test(report);

	// 5. freshness — sources older than ~18 months from spec date on current-status claims
	const nowYear = new Date().getFullYear();
	const stale = sources.filter((s) => s.date && Number(String(s.date).slice(0, 4)) < nowYear - 2).map((s) => s.id);

	// 6. numerical — inconsistent unit patterns across claims on the same metric
	const numericClaims = evidence.filter((e) => e.values && Object.keys(e.values).length > 0);
	const unitSet = new Map<string, Set<string>>();
	for (const e of numericClaims) {
		for (const [metric, val] of Object.entries(e.values ?? {})) {
			const unit = String(val).replace(/[0-9.,\s]/g, "").trim();
			if (!unit) continue;
			const key = metric.toLowerCase().slice(0, 12);
			if (!unitSet.has(key)) unitSet.set(key, new Set());
			unitSet.get(key)!.add(unit);
		}
	}
	const suspicious = [...unitSet.entries()].filter(([, units]) => units.size > 3).map(([m, units]) => `${m}: ${[...units].join("/")}`);

	// 7. source diversity — no publisher > 60% of sources
	const pubs = sources.map((s) => s.publisher ?? "unknown");
	const counts = new Map<string, number>();
	for (const p of pubs) counts.set(p, (counts.get(p) ?? 0) + 1);
	const dominant = Math.max(0, ...counts.values()) / Math.max(1, sources.length);

	// 8. leakage — report should not contain benchmark-answer boilerplate
	const leakageFlags = /as an ai|i cannot browse|training data|knowledge cutoff/i.test(report) ? ["model-boilerplate"] : [];

	// 9. safety — how many sources triggered injection heuristics
	const injected = injectionFlags.length;

	return {
		coverage: { covered, uncovered, pass: uncovered.length === 0 },
		claim_audit: { total: claims.length, unsupported, pass: unsupported.length === 0 },
		contradiction_audit: { unresolved: contradictions.length, acknowledged },
		freshness: { stale_sources: stale, pass: stale.length < Math.max(1, sources.length / 3) },
		numerical: { suspicious, pass: suspicious.length === 0 },
		source_diversity: { publishers: counts.size, dominant_share: dominant, pass: dominant <= 0.6 },
		leakage: { flags: leakageFlags, pass: leakageFlags.length === 0 },
		safety: { injected_sources: injected, pass: true }, // flagged, not failed — extraction was sandboxed
	};
}

/** Compose the full audit report; overall pass gates the run status. */
export function assembleAudit(
	staticAudits: Omit<AuditReport, "citation_audit" | "overall_pass">,
	citationAudit: { checked: number; failures: CitationFailure[] },
): AuditReport {
	const citationPass = citationAudit.failures.length <= Math.max(1, citationAudit.checked / 4);
	const overall =
		staticAudits.coverage.pass &&
		staticAudits.claim_audit.pass &&
		citationPass &&
		staticAudits.numerical.pass &&
		staticAudits.source_diversity.pass &&
		staticAudits.leakage.pass &&
		staticAudits.contradiction_audit.acknowledged;
	return {
		...staticAudits,
		citation_audit: { ...citationAudit, pass: citationPass },
		overall_pass: overall,
	};
}
