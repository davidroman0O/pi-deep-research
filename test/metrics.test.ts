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
