// src/prompts-policy.ts — the agent's decision prompts (§14/§15/§16/§20).
//
// These differ from the content prompts in prompts.ts: they drive CONTROL FLOW,
// not report prose. Each returns a typed Action via a tool call. The agent sees
// the full executive-state snapshot (§13.5) and reasons about information gain.

import { Type } from "typebox";
import { INSTRUCTION_HIERARCHY } from "./trust.ts";
import type { MemorySnapshot } from "./policy.ts";
import type { Task } from "./store.ts";

function controlPlane(phase: string, instructions: string): string {
	return `${INSTRUCTION_HIERARCHY}

<protected_task_definition phase="${phase}">
  <governing_policy>${instructions}</governing_policy>
</protected_task_definition>`;
}

function snapshotXml(s: MemorySnapshot): string {
	const corrob = s.claims.filter((c) => c.corroborated).length;
	const singleSource = s.claims.filter((c) => c.sourceCount === 1).length;
	return `<research_state>
  <objective>${s.spec.objective}</objective>
  <dimensions>${s.spec.dimensions.join(" | ")}</dimensions>
  <tasks>
${s.tasks.map((t) => `    <task id="${t.id}" status="${t.status}" depth="${t.depth}">${t.question}</task>`).join("\n")}
  </tasks>
  <evidence_summary claims="${s.claims.length}" corroborated_2plus_publishers="${corrob}" single_source="${singleSource}" contradictions="${s.contradictions}" />
  <claims_needing_corroboration>
${s.claims.filter((c) => !c.corroborated && c.sourceCount === 1).slice(0, 12).map((c) => `    <claim id="${c.id}" conf="${c.confidence.toFixed(2)}">${c.text}</claim>`).join("\n")}
  </claims_needing_corroboration>
  <coverage covered="${s.coverage.covered.length}/${s.coverage.covered.length + s.coverage.uncovered.length}" uncovered="${s.coverage.uncovered.join(" | ")}" />
  <budget sources="${s.budget.sourcesUsed}/${s.budget.sourcesMax}" iterations="${s.budget.iterationsUsed}/${s.budget.iterationsMax}" />
</research_state>`;
}

// ── §16: task selection (highest gap) ─────────────────────────────────────
export const TASK_SELECTOR_SYSTEM = controlPlane(
	"select_task",
	`Your sole directive is to pick the NEXT task to research — the one with the highest information gap. Apply the gap score: Importance × (1 − Coverage) × Uncertainty. Prefer (a) open tasks touching uncovered spec dimensions, (b) tasks whose existing claims are single-sourced and need corroboration, (c) high-priority tasks not yet started. If all tasks are done and no gaps remain, pick the lowest-confidence area to deepen. Never invent a task id not in the state.`,
);

export function taskSelectorPrompt(s: MemorySnapshot): string {
	return `${snapshotXml(s)}

Pick the task with the highest gap via the tool.`;
}

export const TASK_SELECTOR_TOOL = {
	name: "select_task",
	description: "Select the next task to research — highest gap first.",
	parameters: Type.Object({
		taskId: Type.String({ description: "An open/in_progress task id from the state." }),
		gapReason: Type.String({ description: "Why this task has the highest gap (coverage, corroboration, priority)." }),
		expectedGain: Type.Number({ description: "Estimated information gain 0..1." }),
	}),
};

// ── §15: action selection ─────────────────────────────────────────────────
export const ACTION_POLICY_SYSTEM = controlPlane(
	"choose_action",
	`Your sole directive is to choose the NEXT action for the current task, maximizing Expected Information Gain. The action set:
- "search": run new web queries (supply queries) — use when the task has no/few sources, or to find INDEPENDENT corroboration.
- "read_deeper": fetch & parse a specific source URL fully — use when a known source was only skimmed.
- "verify": corroborate a specific claim by searching for independent sources — MANDATORY when a claim has only 1 publisher. This is the corroboration action.
- "extract": pull evidence from an already-fetched document — use when a doc is fetched but not yet mined for this task.
- "summarize": write the task memo and mark the task done — use when the task has >= 2 corroborated claims or sources are saturated for it.
- "stop": no further action adds value — use when coverage is adequate AND remaining claims are corroborated AND budget is near exhaustion.

Prioritize "verify" over "search" whenever a high-importance claim sits single-sourced — independent corroboration is the highest-value action for research quality. Estimate EIG honestly: a verify on a contested claim is worth more than another broad search.`,
);

export function actionPolicyPrompt(task: Task, s: MemorySnapshot): string {
	const taskClaims = s.claims.filter((c) => c.text.length > 0).slice(0, 20);
	return `<current_task id="${task.id}" priority="${task.priority}">
${task.question}
</current_task>
<completion_test>${task.completion_test ?? "(unspecified)"}</completion_test>

${snapshotXml(s)}

<task_relevant_claims>
${taskClaims.map((c) => `  <claim id="${c.id}" conf="${c.confidence.toFixed(2)}" sources="${c.sourceCount}" publishers="${c.independentPublishers}" corroborated="${c.corroborated}">${c.text}</claim>`).join("\n")}
</task_relevant_claims>

Choose the next action via the tool.`;
}

export const ACTION_POLICY_TOOL = {
	name: "choose_action",
	description: "Choose the next research action for the current task.",
	parameters: Type.Object({
		type: Type.Union([Type.Literal("search"), Type.Literal("read_deeper"), Type.Literal("verify"), Type.Literal("extract"), Type.Literal("summarize"), Type.Literal("stop")]),
		taskId: Type.String(),
		queries: Type.Optional(Type.Array(Type.String(), { description: "Required for search/verify. For verify: queries targeting independent corroboration of claimId." })),
		claimId: Type.Optional(Type.String({ description: "Required for verify: the single-sourced claim to corroborate." })),
		sourceUrl: Type.Optional(Type.String({ description: "Required for read_deeper." })),
		expectedInformationGain: Type.Number({ minimum: 0, maximum: 1 }),
		reason: Type.String({ description: "Why this action, given the state." }),
	}),
};

// ── §20: stopping ─────────────────────────────────────────────────────────
export const STOP_POLICY_SYSTEM = controlPlane(
	"stop_policy",
	`Your sole directive is to decide whether the research loop should stop. Stop when the marginal expected value of another action is too low: coverage adequate, high-priority gaps resolved, and max remaining EIG below ~0.08. Do NOT stop prematurely — single-sourced high-importance claims, uncovered dimensions, or unresolved contradictions all justify continuing if budget allows. Budget near exhaustion is a valid stop reason regardless.`,
);

export function stopPolicyPrompt(s: MemorySnapshot): string {
	const uncorroboratedImportant = s.claims.filter((c) => !c.corroborated && c.confidence >= 0.6).length;
	return `${snapshotXml(s)}
<signal_important_uncorroborated>${uncorroboratedImportant}</signal_important_uncorroborated>

Decide stop/continue via the tool.`;
}

export const STOP_POLICY_TOOL = {
	name: "stop_decision",
	description: "Decide whether the research loop should stop.",
	parameters: Type.Object({
		stop: Type.Boolean(),
		maxExpectedGain: Type.Number({ description: "Highest remaining EIG across all possible actions, 0..1." }),
		reason: Type.String(),
	}),
};
