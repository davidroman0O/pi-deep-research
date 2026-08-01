import { expect, test } from "bun:test";
import { computeMetrics } from "../src/metrics.ts";
import type { AuditReport } from "../src/audits.ts";
import type { Claim, Evidence, Source } from "../src/store.ts";

const sources: Source[] = [
	{ id: "s1", url: "https://one.example/a", title: "One", source_family: "one", quality: "high", hash: "1" },
	{ id: "s2", url: "https://two.example/b", title: "Two", source_family: "two", quality: "high", hash: "2" },
];
const evidence: Evidence[] = [
	{ id: "e1", task_id: "t1", source_id: "s1", claim: "Method A establishes the estimate.", confidence: 0.9 },
	{ id: "e2", task_id: "t1", source_id: "s2", claim: "Sensitivity analysis confirms the conclusion.", confidence: 0.9 },
];
const claims: Claim[] = evidence.map((item, index) => ({
	id: `c${index + 1}`,
	text: item.claim,
	status: "high",
	supporting_evidence: [item.id],
	contradicting_evidence: [],
	assumptions: [],
	confidence: 0.9,
	citation_ready: true,
	evidence_ids: [item.id],
	source_ids: [item.source_id],
}));
const audit = {
	coverage: { covered: [], uncovered: [], pass: true },
	citation_audit: { checked: 0, failures: [], pass: true },
	contradiction_audit: { unresolved: 0, acknowledged: true },
} as AuditReport;

test("support edges count as independent corroboration", () => {
	const metrics = computeMetrics(
		{ objective: "", dimensions: [] },
		sources,
		evidence,
		claims,
		[{ from: "c1", to: "c2", relation: "supports" }],
		audit,
	);
	expect(metrics.corroboratedClaims).toBe(2);
	expect(metrics.corroboratedFraction).toBe(1);
});

test("proposition-scoped values corroborate capital-cost claims above 100", () => {
	const scopedEvidence: Evidence[] = [
		{
			id: "e1",
			task_id: "t1",
			source_id: "s1",
			claim: "The overnight cost estimate was $20,139/kW.",
			proposition_key: "smr program | overnight cost | 20139 usd/kw | 2024",
			confidence: 0.9,
		},
		{
			id: "e2",
			task_id: "t1",
			source_id: "s2",
			claim: "An independent model put the overnight cost at $20,000/kW.",
			proposition_key: "smr program | overnight cost | 20000 usd/kw | 2024",
			confidence: 0.9,
		},
	];
	const scopedClaims: Claim[] = scopedEvidence.map((item, index) => ({
		...claims[index],
		text: item.claim,
		evidence_ids: [item.id],
		source_ids: [item.source_id],
	}));
	const metrics = computeMetrics(
		{ objective: "", dimensions: [] }, sources, scopedEvidence, scopedClaims, [], audit,
	);
	expect(metrics.corroboratedClaims).toBe(2);
	expect(metrics.corroboratedFraction).toBe(1);
});
