import { expect, test } from "bun:test";
import { computeMetrics } from "../src/metrics.ts";
import type { AuditReport } from "../src/audits.ts";
import type { Claim, Evidence, Source } from "../src/store.ts";

// Evidence-polarity pins (DRH review 5): duplicates NEVER corroborate, and
// non-support relations (contradicts/qualifies) are never counted as corroboration.

const audit = {
	coverage: { covered: [], uncovered: [], pass: true },
	citation_audit: { checked: 0, failures: [], pass: true },
	contradiction_audit: { unresolved: 0, acknowledged: true },
} as AuditReport;

function fixture(family: string) {
	const sources: Source[] = [
		{ id: "s1", url: "https://x.example/a", title: "A", source_family: family, quality: "high", hash: "1" },
		{ id: "s2", url: "https://x.example/b", title: "B", source_family: family, quality: "high", hash: "2" },
	];
	const evidence: Evidence[] = [
		{ id: "e1", task_id: "t1", source_id: "s1", claim: "Vogtle FOAK capital cost is $20,139/kW.", confidence: 0.9 },
		{ id: "e2", task_id: "t1", source_id: "s2", claim: "Vogtle unit cost reached $20,139/kW.", confidence: 0.9 },
	];
	const claims: Claim[] = evidence.map((item, i) => ({
		id: `c${i + 1}`, text: item.claim, status: "high", supporting_evidence: [item.id],
		contradicting_evidence: [], assumptions: [], confidence: 0.9, citation_ready: true,
		evidence_ids: [item.id], source_ids: [item.source_id],
	}));
	return { sources, evidence, claims };
}

const spec = { objective: "", dimensions: [] };

for (const relation of ["duplicate", "supports", "contradicts", "qualifies"] as const) {
	test(`${relation} edges within one family never count as corroboration`, () => {
		const f = fixture("same");
		const m = computeMetrics(spec, f.sources, f.evidence, f.claims, [{ from: "c1", to: "c2", relation }], audit);
		expect(m.corroboratedClaims).toBe(0);
	});
}

test("cross-family duplicate VALUES still corroborate via entity+value fallback", () => {
	const f = fixture("same");
	f.sources[1].source_family = "other";
	const m = computeMetrics(spec, f.sources, f.evidence, f.claims, [], audit);
	expect(m.corroboratedClaims).toBe(2);
});
