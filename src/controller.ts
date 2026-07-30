// src/controller.ts — the action executor dispatch + safety guards.
//
// DESIGN_SPEC §2.2/§2.3. This module provides:
//   - Task state machine transitions (§2.3)
//   - Action safety guards (§2.6 — prevents oscillation, budget exhaustion)
//   - Completion test evaluation (§4.2 — "sufficient evidence?" not "did I search?")
//   - Default required_evidence policies by priority (§2.5/§11.2)

import type { Task, TaskState, Evidence, Source, ClaimEdge } from "./store.ts";
import { clusterClaims } from "./claimgraph.ts";
import { detectSourceFamily } from "./novel.ts";

// ── safety constants (§2.6) ──────────────────────────────────────────────
export const MAX_ATTEMPTS_PER_TASK = 5;
export const MAX_ACTIONS = 500;
export const MAX_WALLCLOCK_MS = 30 * 60_000; // 30 min
export const LOW_NOVELTY_SATURATION = 5; // consecutive low-novelty → stop
export const STOP_EIG_THRESHOLD = 0.08; // §20 — max_EIG below this → stop

// ── default required_evidence by priority (§11.2) ────────────────────────
export function defaultRequiredEvidence(priority: number): string[] {
	if (priority >= 8) {
		return ["≥2 independent primary sources", "≥1 quantitative figure with stated conditions", "no unresolved contradiction"];
	}
	if (priority >= 5) {
		return ["≥2 independent publishers", "≥1 primary source"];
	}
	return ["≥1 credible source"];
}

// ── task state machine (§2.3) ────────────────────────────────────────────

/** Allowed actions per task state. Gates which actions the model can choose. */
export function allowedActions(state: TaskState): string[] {
	switch (state) {
		case "open": return ["search"];
		case "discovery": return ["search", "read_deeper"];
		case "evidence_gathering": return ["search", "extract", "read_deeper"];
		case "corroboration": return ["verify", "search"];
		case "resolving": return ["summarize"];
		case "complete": return [];
	}
}

/** Transition a task's state based on evidence accrued. */
export function transitionState(task: Task, evidence: Evidence[], sources: Source[], edges: ClaimEdge[]): TaskState {
	const taskEvidence = evidence.filter((e) => e.task_id === task.id);
	const taskSources = sources.filter((s) => taskEvidence.some((e) => e.source_id === s.id));

	switch (task.state) {
		case "open":
			if (taskSources.length >= 1) return "discovery";
			return "open";

		case "discovery":
			if (taskEvidence.length >= 1) return "evidence_gathering";
			if (taskSources.length >= 1) return "discovery";
			return "discovery";

		case "evidence_gathering": {
			// Check if required_evidence is satisfied → corroboration
			const satisfied = evaluateRequiredEvidence(task, evidence, sources, edges);
			if (satisfied || task.search_attempts >= MAX_ATTEMPTS_PER_TASK) return "corroboration";
			return "evidence_gathering";
		}

		case "corroboration": {
			// Check if corroboration requirements met → resolving
			const corroborationMet = checkCorroboration(task, evidence, sources);
			if (corroborationMet) return "resolving";
			return "corroboration";
		}

		case "resolving":
			return "complete";

		case "complete":
			return "complete";
	}
}

// ── completion test (§4.2) ───────────────────────────────────────────────

/** "Do I possess sufficient evidence?" — evaluates required_evidence strings against actual evidence. */
export function isTaskComplete(task: Task, evidence: Evidence[], sources: Source[], edges: ClaimEdge[]): boolean {
	if (task.state === "complete") return true;
	if (task.state !== "resolving") return false; // corroboration phase must run before completion

	const taskEvidence = evidence.filter((e) => e.task_id === task.id);
	const taskSources = sources.filter((s) => taskEvidence.some((e) => e.source_id === s.id));

	// minimum evidence for any task
	if (taskEvidence.length === 0) return false;

	// check required_evidence policies
	return evaluateRequiredEvidence(task, evidence, sources, edges);
}

/** Evaluate the task's required_evidence strings against actual evidence state. */
function evaluateRequiredEvidence(task: Task, evidence: Evidence[], sources: Source[], edges: ClaimEdge[]): boolean {
	const taskEvidence = evidence.filter((e) => e.task_id === task.id);
	const taskSources = sources.filter((s) => taskEvidence.some((e) => e.source_id === s.id));
	const taskSourceFamilies = new Set(
		taskSources.map((s) => s.source_family ?? detectSourceFamily(s.url, s.publisher ?? "")),
	);
	const taskEdges = edges.filter(
		(e) => taskEvidence.some((ev) => ev.id === e.from) || taskEvidence.some((ev) => ev.id === e.to),
	);

	for (const req of task.required_evidence) {
		const reqLower = req.toLowerCase();

		if (reqLower.includes("≥2 independent primary") || reqLower.includes("≥2 independent publisher")) {
			if (taskSourceFamilies.size < 2) return false;
		} else if (reqLower.includes("≥1 quantitative")) {
			if (!taskEvidence.some((e) => e.values && Object.keys(e.values).length > 0)) return false;
		} else if (reqLower.includes("no unresolved contradiction")) {
			if (taskEdges.some((e) => e.relation === "contradicts")) return false;
		} else if (reqLower.includes("≥1 primary source")) {
			if (!taskSources.some((s) => s.quality === "high")) return false;
		} else if (reqLower.includes("≥1 credible source")) {
			if (taskSources.length < 1) return false;
		}
	}
	return true;
}

/** Check if a majority of high-confidence claim clusters have independent support. */
function checkCorroboration(task: Task, evidence: Evidence[], sources: Source[]): boolean {
	const taskEvidence = evidence.filter((e) => e.task_id === task.id && e.confidence >= 0.5);
	if (taskEvidence.length === 0) return true; // nothing to corroborate

	const familyBySource = new Map(
		sources.map((s) => [s.id, s.source_family ?? detectSourceFamily(s.url, s.publisher ?? "")]),
	);
	const clusters = clusterClaims(taskEvidence);
	if (clusters.length === 0) return true;
	const corroborated = clusters.filter((cluster) =>
		new Set(cluster.map((e) => familyBySource.get(e.source_id)).filter(Boolean)).size >= 2,
	).length;
	return corroborated > clusters.length / 2;
}

/** Pick one high-confidence representative per claim cluster that still lacks independent support. */
export function selectVerificationTargets(evidence: Evidence[], sources: Source[]): Evidence[] {
	const familyBySource = new Map(
		sources.map((s) => [s.id, s.source_family ?? detectSourceFamily(s.url, s.publisher ?? "")]),
	);
	return clusterClaims(evidence)
		.filter((cluster) => {
			if (!cluster.some((e) => e.confidence >= 0.6)) return false;
			const families = new Set(
				cluster.map((e) => familyBySource.get(e.source_id)).filter(Boolean) as string[],
			);
			return families.size < 2;
		})
		.map((cluster) => cluster.reduce((best, e) => e.confidence > best.confidence ? e : best))
		.sort((a, b) => b.confidence - a.confidence);
}

// ── action safety guards (§2.6) ──────────────────────────────────────────

export interface Budget {
	actionsUsed: number;
	maxActions: number;
	sourcesUsed: number;
	maxSources: number;
	iterationsUsed: number;
	maxIterations: number;
	wallclockStart: number;
	maxWallclockMs: number;
}

export function createBudget(config: { max_sources: number; max_iterations: number }): Budget {
	return {
		actionsUsed: 0,
		maxActions: MAX_ACTIONS,
		sourcesUsed: 0,
		maxSources: config.max_sources,
		iterationsUsed: 0,
		maxIterations: config.max_iterations,
		wallclockStart: Date.now(),
		maxWallclockMs: MAX_WALLCLOCK_MS,
	};
}

export function isBudgetExhausted(budget: Budget): boolean {
	return (
		budget.actionsUsed >= budget.maxActions ||
		budget.sourcesUsed >= budget.maxSources ||
		budget.iterationsUsed >= budget.maxIterations ||
		Date.now() - budget.wallclockStart >= budget.maxWallclockMs
	);
}

/** Check if an action is safe to execute. Returns a coerced action if not. */
export function guardAction(
	action: { type: string; taskId: string },
	task: Task,
	budget: Budget,
): { type: string; taskId: string; coerced?: boolean; reason?: string } {
	// budget exhaustion → force summarize
	if (isBudgetExhausted(budget)) {
		return { type: "summarize", taskId: action.taskId, coerced: true, reason: "budget exhausted" };
	}

	// Search cap stops more discovery, not the verification phase it unlocks.
	if (task.search_attempts >= MAX_ATTEMPTS_PER_TASK && action.type === "search") {
		return { type: "summarize", taskId: action.taskId, coerced: true, reason: `search attempt cap (${MAX_ATTEMPTS_PER_TASK})` };
	}

	// state machine: action not allowed in current state → coerce to summarize
	const allowed = allowedActions(task.state);
	if (!allowed.includes(action.type)) {
		return { type: "summarize", taskId: action.taskId, coerced: true, reason: `action ${action.type} not allowed in state ${task.state}` };
	}

	return action;
}
