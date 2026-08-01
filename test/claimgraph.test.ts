import { expect, test } from "bun:test";
import {
	claimClusterCandidates,
	clusterClaims,
	coalesceClaimClusters,
	type ClaimRelation,
} from "../src/claimgraph.ts";
import type { Evidence } from "../src/store.ts";

const first: Evidence = {
	id: "e1",
	task_id: "t1",
	source_id: "s1",
	claim: "NuScale estimated its first SMR's overnight cost at $20,139/kWe.",
	proposition_key: "nuscale smr | foak overnight cost | 20139 usd/kwe | united states 2022",
	conditions: "capacity_factor=90%",
	confidence: 0.9,
};

const paraphrase: Evidence = {
	id: "e2",
	task_id: "t1",
	source_id: "s2",
	claim: "The initial VOYGR deployment carried a 2022 capital estimate of USD 20,139 per electrical kilowatt.",
	proposition_key: "voygr | first plant capital estimate | 20139 usd/kwe | us foak 2022",
	conditions: "capacity_factor=90%",
	confidence: 0.8,
};

const conflicts: Evidence[] = [
	{ ...paraphrase, id: "e3-value", source_id: "s3-value", proposition_key: "voygr | first plant capital estimate | 22500 usd/kwe | us foak 2022" },
	{ ...paraphrase, id: "e3-unit", source_id: "s3-unit", proposition_key: "voygr | first plant capital estimate | 20139 usd/mwh | us foak 2022" },
	{ ...paraphrase, id: "e3-date", source_id: "s3-date", proposition_key: "voygr | first plant capital estimate | 20139 usd/kwe | us foak 2023" },
	{ ...paraphrase, id: "e3-scope", source_id: "s3-scope", proposition_key: "voygr | first plant capital estimate | 20139 usd/kwe | europe foak 2022" },
	{ ...paraphrase, id: "e3-polarity", source_id: "s3-polarity", claim: "The initial VOYGR deployment did not carry that capital estimate.", proposition_key: "voygr | did not have first plant capital estimate | 20139 usd/kwe | us foak 2022" },
	{ ...paraphrase, id: "e3-condition", source_id: "s3-condition", conditions: "capacity_factor=60%" },
];

const mockRelation = (_a: Evidence[], _b: Evidence[]): ClaimRelation => "duplicate";

test("relation candidates include comparable conflicts but coalescing never merges them", () => {
	for (const conflict of conflicts) {
		const provisional = clusterClaims([first, paraphrase, conflict]);
		const blockedPairs = claimClusterCandidates(provisional);
		expect(provisional.map((cluster) => cluster.map((e) => e.id))).toEqual([["e1"], ["e2"], [conflict.id]]);
		expect(blockedPairs).toEqual([[0, 1], [1, 2]]);

		const mockedDuplicates = blockedPairs.filter(([a, b]) => mockRelation(provisional[a], provisional[b]) === "duplicate");
		const merged = coalesceClaimClusters(provisional, mockedDuplicates);
		expect(merged.map((cluster) => cluster.map((e) => e.id))).toEqual([["e1", "e2"], [conflict.id]]);
		expect(merged.flatMap((cluster) => cluster.map((e) => e.source_id)).sort()).toEqual(["s1", "s2", conflict.source_id].sort());

		const allMockedDuplicate: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]];
		expect(coalesceClaimClusters(provisional, allMockedDuplicate).map((cluster) => cluster.map((e) => e.id)))
			.toEqual([["e1", "e2"], [conflict.id]]);
	}
});

test("coalescing requires duplicate relations to every member", () => {
	const third = {
		...paraphrase,
		id: "e3",
		source_id: "s3",
		claim: "A separate SMR program quoted the same build figure.",
		proposition_key: "smr program | quoted construction cost | 20139 usd/kwe | north america 2022",
	};
	const merged = coalesceClaimClusters([[first], [paraphrase], [third]], [[0, 1], [1, 2]]);
	expect(merged.map((cluster) => cluster.map((e) => e.id))).toEqual([["e1", "e2"], ["e3"]]);
});
