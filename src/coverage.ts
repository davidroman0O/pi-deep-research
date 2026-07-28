// src/coverage.ts — deterministic coverage matrix builder (§16).
//
// Built from evidence + claims + sources + edges. No model calls.
// The planner reads this to select the next task (§16 gap score).
// A dimension is "complete" only when it has evidence AND corroboration.

import type { Spec, Evidence, Claim, ClaimEdge, Source, Task } from "./store.ts";
import { detectSourceFamily } from "./novel.ts";

export interface DimensionCoverage {
	name: string;
	hasEvidence: boolean;
	hasPrimary: boolean;
	hasCorroboration: boolean;
	hasContradiction: boolean;
	status: "complete" | "partial" | "open";
}

export interface TaskCoverage {
	taskId: string;
	coverage: number; // 0..1, fraction of required_evidence satisfied
	uncertainty: number; // §19 formula
	gapScore: number; // priority × (1 − coverage) × uncertainty
}

export interface CoverageMatrix {
	dimensions: DimensionCoverage[];
	tasks: TaskCoverage[];
	overallCoverage: number;
	openDimensions: string[];
}

export function buildCoverageMatrix(
	spec: Spec,
	tasks: Task[],
	evidence: Evidence[],
	claims: Claim[],
	sources: Source[],
	edges: ClaimEdge[],
): CoverageMatrix {
	const sourceFamily = new Map(
		sources.map((s) => [s.id, s.source_family ?? detectSourceFamily(s.url, s.publisher ?? "unknown")]),
	);

	// ── dimension coverage ────────────────────────────────────────────────
	const dimensions: DimensionCoverage[] = spec.dimensions.map((dim) => {
		const dimKey = dim.toLowerCase().split(" ")[0]?.slice(0, 10) ?? dim.toLowerCase();
		const dimEvidence = evidence.filter((e) => {
			const text = (e.claim + " " + (e.conditions ?? "")).toLowerCase();
			return text.includes(dimKey) || text.includes(dim.toLowerCase().slice(0, 8));
		});
		const dimSources = sources.filter((s) =>
			dimEvidence.some((e) => e.source_id === s.id),
		);
		const dimFamilies = new Set(dimSources.map((s) => sourceFamily.get(s.id)).filter(Boolean));
		const dimContradictions = edges.filter(
			(e) => e.relation === "contradicts" &&
				(evidence.some((ev) => ev.id === e.from && dimEvidence.includes(ev)) ||
				 evidence.some((ev) => ev.id === e.to && dimEvidence.includes(ev))),
		);

		const hasEvidence = dimEvidence.length > 0;
		const hasPrimary = dimSources.some((s) => s.quality === "high");
		const hasCorroboration = dimFamilies.size >= 2;
		const hasContradiction = dimContradictions.length > 0;

		let status: DimensionCoverage["status"];
		if (hasEvidence && hasCorroboration && !hasContradiction) status = "complete";
		else if (hasEvidence) status = "partial";
		else status = "open";

		return { name: dim, hasEvidence, hasPrimary, hasCorroboration, hasContradiction, status };
	});

	// ── task coverage ─────────────────────────────────────────────────────
	const taskCoverage: TaskCoverage[] = tasks.map((task) => {
		const taskEvidence = evidence.filter((e) => e.task_id === task.id);
		const taskSources = sources.filter((s) => taskEvidence.some((e) => e.source_id === s.id));
		const taskFamilies = new Set(
			taskSources.map((s) => sourceFamily.get(s.id)).filter(Boolean) as string[],
		);

		// coverage: how many required_evidence strings are satisfied
		let satisfied = 0;
		for (const req of task.required_evidence ?? []) {
			const rl = req.toLowerCase();
			if ((rl.includes("≥2 independent") || rl.includes("≥ 2 independent")) && taskFamilies.size >= 2) satisfied++;
			else if (rl.includes("≥1 quantitative") && taskEvidence.some((e) => e.values && Object.keys(e.values).length > 0)) satisfied++;
			else if (rl.includes("≥1 primary") && taskSources.some((s) => s.quality === "high")) satisfied++;
			else if (rl.includes("≥1 credible") && taskSources.length >= 1) satisfied++;
			else if (rl.includes("no unresolved") && !edges.some((e) => e.relation === "contradicts" && taskEvidence.some((ev) => ev.id === e.from || ev.id === e.to))) satisfied++;
		}
		const reqCount = Math.max(1, task.required_evidence?.length ?? 1);
		const coverage = satisfied / reqCount;

		// uncertainty (§19 simplified): high when few sources, low when corroborated
		const independentCount = taskFamilies.size;
		const hasContradiction = edges.some(
			(e) => e.relation === "contradicts" &&
				(taskEvidence.some((ev) => ev.id === e.from) || taskEvidence.some((ev) => ev.id === e.to)),
		);
		const uncertainty = Math.max(0, 1 - 0.3 * independentCount - (hasContradiction ? 0.2 : 0));

		// gap score: priority × (1 − coverage) × uncertainty
		const gapScore = task.priority * (1 - coverage) * uncertainty;

		return { taskId: task.id, coverage, uncertainty, gapScore };
	});

	const overallCoverage = dimensions.filter((d) => d.status === "complete").length / Math.max(1, dimensions.length);
	const openDimensions = dimensions.filter((d) => d.status !== "complete").map((d) => d.name);

	return { dimensions, tasks: taskCoverage, overallCoverage, openDimensions };
}
