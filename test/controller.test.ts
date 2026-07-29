import { expect, test } from "bun:test";
import {
	createBudget,
	guardAction,
	isTaskComplete,
	MAX_ATTEMPTS_PER_TASK,
	transitionState,
} from "../src/controller.ts";
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

test("search cap still permits claim verification", () => {
	expect(transitionState(task, evidence, sources, [])).toBe("corroboration");
	expect(isTaskComplete(task, evidence, sources, [])).toBe(false);
	const budget = createBudget({ max_sources: 10, max_iterations: 4 });
	expect(guardAction({ type: "verify", taskId: task.id }, task, budget).type).toBe("verify");
	expect(guardAction({ type: "search", taskId: task.id }, task, budget).type).toBe("summarize");
});
