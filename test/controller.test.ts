import { expect, test } from "bun:test";
import {
	createBudget,
	guardAction,
	isTaskComplete,
	MAX_ATTEMPTS_PER_TASK,
	selectVerificationTargets,
	transitionState,
} from "../src/controller.ts";
import { prepareVerificationEvidence, sourceLimitForAction } from "../src/orchestrator.ts";
import type { Evidence, Source, Task } from "../src/store.ts";

const task: Task = {
	id: "t1",
	question: "Verify this claim",
	priority: 5,
	status: "in_progress",
	state: "corroboration",
	depth: 0,
	coverage: 0,
	uncertainty: 1,
	required_evidence: ["≥1 credible source"],
	search_attempts: MAX_ATTEMPTS_PER_TASK,
};
const evidence: Evidence[] = [{
	id: "e1",
	task_id: task.id,
	source_id: "s1",
	claim: "A single-sourced claim",
	confidence: 0.9,
}];
const sources: Source[] = [{
	id: "s1",
	url: "https://one.example/report",
	title: "Report",
	publisher: "one.example",
	source_family: "one.example",
	quality: "high",
	hash: "1",
}];

test("state transition catches up to accumulated evidence", () => {
	const fresh = { ...task, state: "open" as const, search_attempts: 1 };
	expect(transitionState(fresh, evidence, sources, [])).toBe("corroboration");

	const underSupported = {
		...fresh,
		required_evidence: ["≥2 independent publishers"],
	};
	expect(transitionState(underSupported, evidence, sources, [])).toBe("evidence_gathering");
});

test("search cap still permits claim verification", () => {
	expect(transitionState(task, evidence, sources, [])).toBe("corroboration");
	expect(isTaskComplete(task, evidence, sources, [])).toBe(false);
	const budget = createBudget({ max_sources: 10, max_iterations: 4 });
	expect(guardAction({ type: "verify", taskId: task.id }, task, budget).type).toBe("verify");
	expect(guardAction({ type: "search", taskId: task.id }, task, budget).type).toBe("summarize");
});

test("verification targets are unique uncorroborated proposition clusters", () => {
	const targetSources: Source[] = [
		{ ...sources[0], id: "s1", source_family: "family-a" },
		{ ...sources[0], id: "s2", url: "https://mirror.example/report", publisher: "mirror.example", source_family: "family-a", hash: "2" },
		{ ...sources[0], id: "s3", url: "https://independent.example/report", publisher: "independent.example", source_family: "family-b", hash: "3" },
	];
	const targetEvidence: Evidence[] = [
		{ ...evidence[0], id: "e1", source_id: "s1", claim: "NuScale overnight cost was $20,139/kW in 2022", proposition_key: "nuscale | overnight cost | 20139 usd/kw | 2022", confidence: 0.9 },
		{ ...evidence[0], id: "e2", source_id: "s2", claim: "An independent estimate confirms the same figure", proposition_key: " NuScale|overnight  cost|20,139 usd/kw|2022 ", confidence: 0.8 },
		{ ...evidence[0], id: "e3", source_id: "s1", claim: "NuScale's cancellation charge was $50 million in 2029", proposition_key: "nuscale | cancellation charge | 50 million usd | 2029", confidence: 0.7 },
	];

	expect(selectVerificationTargets(targetEvidence, targetSources).map((e) => e.id)).toEqual(["e1", "e3"]);

	const independentSupport: Evidence = { ...targetEvidence[0], id: "e4", source_id: "s3", confidence: 0.85 };
	expect(selectVerificationTargets([...targetEvidence, independentSupport], targetSources).map((e) => e.id)).toEqual(["e3"]);
});

test("verification evidence inherits target identity only after explicit support", () => {
	const targetKey = "nuscale | overnight cost | 20139 usd/kw | 2022";
	const accepted = prepareVerificationEvidence([
		{ claim: "Same fact", proposition_key: "extractor | invented | key | none", target_relation: "supports", confidence: 0.9 },
		{ claim: "Same fact restated", proposition_key: "another | invented | key | none", target_relation: "duplicate", confidence: 0.8 },
		{ claim: "Different scope", proposition_key: targetKey, target_relation: "qualifies", confidence: 0.9 },
		{ claim: "Opposite fact", proposition_key: targetKey, target_relation: "contradicts", confidence: 0.9 },
		{ claim: "Unclassified", proposition_key: targetKey, confidence: 0.9 },
	], targetKey);

	expect(accepted.map((e) => [e.claim, e.proposition_key])).toEqual([
		["Same fact", targetKey],
		["Same fact restated", targetKey],
	]);
});

test("ordinary search leaves source slots for verification", () => {
	expect(sourceLimitForAction(10, "search")).toBe(7);
	expect(sourceLimitForAction(10, "verify")).toBe(10);
	expect(sourceLimitForAction(2, "search")).toBe(1);
});
