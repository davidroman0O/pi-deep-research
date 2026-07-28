// src/policy.ts — the agent's decision layer (§14/§15/§16/§20).
//
// THIS is what makes the pipeline agentic rather than a fixed sequence. Three
// model-driven decisions, each schema-enforced via a typed Action tool:
//
//   selectNextTask(memory)  → which subquestion has the highest gap?  (§16)
//   chooseAction(task, mem) → search | read_deeper | verify | extract | summarize | stop  (§15)
//   shouldStop(memory)      → continue/stop + max EIG + reason  (§20)
//
// The controller (orchestrator) loops: pick task → pick action → execute →
// repeat until stop. A claim with one source can trigger `verify`, which
// spawns a corroborating search — the path that lifts corroboration from
// ~4% upward. Execution of each action is deterministic code; the JUDGMENT
// of which action is the model's.

import { llmJson, type ModelHandle } from "./llm.ts";
import { Type } from "typebox";
import {
	TASK_SELECTOR_SYSTEM, taskSelectorPrompt, TASK_SELECTOR_TOOL,
	ACTION_POLICY_SYSTEM, actionPolicyPrompt, ACTION_POLICY_TOOL,
	STOP_POLICY_SYSTEM, stopPolicyPrompt, STOP_POLICY_TOOL,
} from "./prompts-policy.ts";
import type { Task, Claim, ClaimEdge, Spec, Evidence, Source } from "./store.ts";

/** Compact executive-state snapshot the agent reasons over (§13.5). */
export interface MemorySnapshot {
	spec: Spec;
	tasks: Array<{ id: string; question: string; status: Task["status"]; depth: number }>;
	claims: Array<{
		id: string;
		text: string;
		confidence: number;
		status: string;
		sourceCount: number;
		independentPublishers: number;
		corroborated: boolean;
	}>;
	contradictions: number;
	coverage: { covered: string[]; uncovered: string[] };
	budget: { sourcesUsed: number; sourcesMax: number; iterationsUsed: number; iterationsMax: number };
}

export function buildSnapshot(
	spec: Spec,
	tasks: Task[],
	claims: Claim[],
	edges: ClaimEdge[],
	sources: Source[],
	config: { max_sources: number; max_iterations: number },
	covered: string[],
	uncovered: string[],
): MemorySnapshot {
	const sourcePublisher = new Map(sources.map((s) => [s.id, s.publisher ?? "unknown"]));
	return {
		spec,
		tasks: tasks.map((t) => ({ id: t.id, question: t.question, status: t.status, depth: t.depth })),
		claims: claims.map((c) => {
			const pubs = new Set(c.source_ids.map((sid) => sourcePublisher.get(sid)).filter(Boolean) as string[]);
			return {
				id: c.id,
				text: c.text,
				confidence: c.confidence,
				status: c.status,
				sourceCount: c.source_ids.length,
				independentPublishers: pubs.size,
				corroborated: pubs.size >= 2,
			};
		}),
		contradictions: edges.filter((e) => e.relation === "contradicts").length,
		coverage: { covered, uncovered },
		budget: { sourcesUsed: sources.length, sourcesMax: config.max_sources, iterationsUsed: 0, iterationsMax: config.max_iterations },
	};
}

/** §16: model picks the highest-gap task to research next. Returns null if none. */
export async function selectNextTask(
	handle: ModelHandle,
	snapshot: MemorySnapshot,
	signal?: AbortSignal,
): Promise<{ taskId: string; gapReason: string; expectedGain: number } | null> {
	const open = snapshot.tasks.filter((t) => t.status === "open" || t.status === "in_progress");
	if (open.length === 0) return null;
	const out = await llmJson<{ taskId: string; gapReason: string; expectedGain: number }>(
		handle,
		TASK_SELECTOR_TOOL,
		TASK_SELECTOR_SYSTEM,
		taskSelectorPrompt(snapshot),
		{ signal, temperature: 0.3 },
	);
	if (!snapshot.tasks.some((t) => t.id === out.taskId)) return null;
	return out;
}

export type ActionType = "search" | "read_deeper" | "verify" | "extract" | "summarize" | "stop";

export interface ActionDecision {
	type: ActionType;
	taskId: string;
	/** search: fresh queries; verify: claim to corroborate; read_deeper: source url. */
	queries?: string[];
	claimId?: string;
	sourceUrl?: string;
	expectedInformationGain: number;
	reason: string;
}

/** §15: model chooses the next action given task + memory. */
export async function chooseAction(
	handle: ModelHandle,
	task: Task,
	snapshot: MemorySnapshot,
	signal?: AbortSignal,
): Promise<ActionDecision> {
	const out = await llmJson<{
		type: ActionType;
		taskId: string;
		queries?: string[];
		claimId?: string;
		sourceUrl?: string;
		expectedInformationGain: number;
		reason: string;
	}>(handle, ACTION_POLICY_TOOL, ACTION_POLICY_SYSTEM, actionPolicyPrompt(task, snapshot), { signal, temperature: 0.4 });
	return out;
}

/** §20: should the controller stop? Hybrid — model gives EIG + coverage, controller applies caps. */
export async function shouldStop(
	handle: ModelHandle,
	snapshot: MemorySnapshot,
	signal?: AbortSignal,
): Promise<{ stop: boolean; maxExpectedGain: number; reason: string }> {
	const out = await llmJson<{ stop: boolean; maxExpectedGain: number; reason: string }>(
		handle,
		STOP_POLICY_TOOL,
		STOP_POLICY_SYSTEM,
		stopPolicyPrompt(snapshot),
		{ signal, temperature: 0.2 },
	);
	return out;
}
