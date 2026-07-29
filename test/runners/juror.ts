// test/runners/juror.ts — blind pairwise juror (swapped ×2).
//
// Generates blind juror prompts with A/B labels randomly assigned and swapped.
// Handles response parsing and verdict aggregation.
//
// The actual LLM evaluation (gpt_chat agent mode) happens in the caller's
// context. This module provides:
//   - generatePrompts(): creates the two blind prompts (original + swapped)
//   - parseResponse(): extracts JurorRun from gpt_chat output text
//   - aggregateVerdict(): combines two runs into a Verdict

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import {
	RUBRIC_WEIGHTS,
	CRITERIA,
	type JurorRun,
	type JurorLabels,
	type Criterion,
	type CriterionScore,
	type Verdict,
	type PerCriterionResult,
} from "../lib/types.ts";

// ── juror tool schema (for native tool-call constrained sampling) ─────────

export const JUROR_TOOL = {
	name: "submit_evaluation",
	description: "Submit blind evaluation of two research reports.",
	parameters: Type.Object({
		scores: Type.Array(
			Type.Object({
				criterion: Type.String(),
				score_a: Type.Integer({ minimum: 1, maximum: 5 }),
				score_b: Type.Integer({ minimum: 1, maximum: 5 }),
				justification: Type.String(),
			}),
			{ minItems: 9 },
		),
		composite_a: Type.Number({ description: "Weighted sum of A's scores, 0-5" }),
		composite_b: Type.Number({ description: "Weighted sum of B's scores, 0-5" }),
		preference: Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("tie")]),
		confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
		key_strengths_a: Type.Array(Type.String()),
		key_weaknesses_a: Type.Array(Type.String()),
		key_strengths_b: Type.Array(Type.String()),
		key_weaknesses_b: Type.Array(Type.String()),
	}),
} as const;

// ── prompt generation ────────────────────────────────────────────────────

/**
// Generate two blind juror prompts (original + swapped).
// A/B labels are randomly assigned to eliminate position bias (§3.3).
 *
// @returns the two prompts + the label mapping (which is A/B in each run)
 */
export function generatePrompts(
	topic: string,
	oursReport: string,
	drhReport: string,
): { prompt1: string; prompt2: string; labels: JurorLabels } {
	// Randomize which report is A in run 1
	const oursFirst = Math.random() < 0.5;

	const run1A = oursFirst ? oursReport : drhReport;
	const run1B = oursFirst ? drhReport : oursReport;
	const labelA1 = oursFirst ? "ours" : "drh";

	// Run 2 is swapped
	const labelA2 = labelA1 === "ours" ? "drh" : "ours";

	const prompt1 = jurorPrompt(topic, run1A, run1B);
	const prompt2 = jurorPrompt(topic, run1B, run1A); // swapped

	const labels: JurorLabels = {
		run1: { A: labelA1, B: labelA1 === "ours" ? "drh" : "ours" },
		run2: { A: labelA2, B: labelA1 },
	};

	return { prompt1, prompt2, labels };
}

function jurorPrompt(topic: string, reportA: string, reportB: string): string {
	return `You are an expert evaluator scoring two research reports on the same topic.
You do NOT know which system produced which report. Score each on the rubric below.

IMPORTANT: Score based on EVIDENCE, not eloquence. A well-written but shallow report must NOT score higher than a less polished but factually rigorous one.

TOPIC: "${topic}"

### REPORT A
${reportA}

### REPORT B
${reportB}

Score each report (A and B separately) on each criterion, 1-5 scale.
Use the FULL range — do not default to 3 for everything:
- 5 = exceptional: best-in-class, no issues, exceeds expectations
- 4 = strong: minor issues only, clearly above average
- 3 = adequate: acceptable but unremarkable, some gaps
- 2 = weak: significant problems, hard to rely on
- 1 = unacceptable: fundamental failures, misleading or wrong

RUBRIC (9 criteria, weighted):
1. factual_accuracy (20%): Are claims correct? Numbers properly represented? Caveats preserved?
2. citation_integrity (20%): Do cited sources actually support adjacent claims? Distinguish specific claims (must cite) from common knowledge (uncited OK).
3. source_quality (15%): Primary sources? Independent? Diverse publishers? Penalize citation spam (many weak sources ≠ good diversity).
4. coverage (15%): Does it fully answer the research question?
5. contradiction_handling (10%): Does it surface disagreements rather than averaging?
6. analytical_depth (5%): Does it synthesize novel insights beyond summarizing sources?
7. timeliness (5%): Is the information current as of the research date?
8. structure_actionability (5%): Well-organized? Can a decision-maker act on it?
9. conciseness (5%): Is every sentence earning its place? Penalize filler/repetition.

For each criterion:
- Score A (1-5)
- Score B (1-5)
- One-sentence justification for the scores

Then state:
- composite_A (weighted sum, 0-5)
- composite_B (weighted sum, 0-5)
- preference: "A", "B", or "tie"
- confidence: "high", "medium", or "low"

Submit your evaluation via the submit_evaluation tool.`;
}

// ── save prompts to disk ─────────────────────────────────────────────────

export async function savePrompts(
	topicDir: string,
	prompts: { prompt1: string; prompt2: string; labels: JurorLabels },
): Promise<void> {
	await writeFile(join(topicDir, "juror-prompt-1.md"), prompts.prompt1, "utf8");
	await writeFile(join(topicDir, "juror-prompt-2.md"), prompts.prompt2, "utf8");
	await writeFile(join(topicDir, "labels.json"), JSON.stringify(prompts.labels, null, 2), "utf8");
}

// ── response parsing ─────────────────────────────────────────────────────

/**
// Parse a gpt_chat response into a JurorRun.
// Handles both native tool-call output and prose JSON.
 */
export function parseResponse(text: string): JurorRun {
	// Try JSON extraction first (model may have output JSON in prose)
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			return normalizeJurorRun(parsed);
		} catch {
			// fall through
		}
	}
	throw new Error("Could not parse juror response — expected JSON or tool-call output");
}

function normalizeJurorRun(raw: Record<string, unknown>): JurorRun {
	const scores = (raw.scores as CriterionScore[] | undefined) ?? [];
	const normalizedScores: CriterionScore[] = CRITERIA.map((criterion) => {
		const found = scores.find((s) => s.criterion === criterion);
		return {
			criterion,
			score_a: found?.score_a ?? 3,
			score_b: found?.score_b ?? 3,
			justification: found?.justification ?? "",
		};
	});

	return {
		scores: normalizedScores,
		composite_a: (raw.composite_a as number) ?? undefined,
		composite_b: (raw.composite_b as number) ?? undefined,
		preference: (raw.preference as JurorRun["preference"]) ?? "tie",
		confidence: (raw.confidence as JurorRun["confidence"]) ?? "low",
		key_strengths_a: (raw.key_strengths_a as string[]) ?? [],
		key_weaknesses_a: (raw.key_weaknesses_a as string[]) ?? [],
		key_strengths_b: (raw.key_strengths_b as string[]) ?? [],
		key_weaknesses_b: (raw.key_weaknesses_b as string[]) ?? [],
	};
}

// ── verdict aggregation ──────────────────────────────────────────────────

/**
// Aggregate two swapped juror runs into a single Verdict.
 *
// Run 1 has A=ours, B=drh (or vice versa).
// Run 2 has the labels swapped.
// This function unswaps both to a canonical "ours/dr" orientation,
// averages the scores, and applies the pass/fail gate.
 */
export function aggregateVerdict(
	run1: JurorRun,
	run2: JurorRun,
	labels: JurorLabels,
	threshold = { ratio: 0.80, hard_floor: 2, critical_floor: 3 },
): Verdict {
	// Determine which label is "ours" in each run, then unswap scores
	const oursScores1 = unswapScores(run1.scores, labels.run1);
	const oursScores2 = unswapScores(run2.scores, labels.run2);

	// Average the two runs
	const perCriterion: PerCriterionResult[] = CRITERIA.map((criterion, i) => {
		const ours = (oursScores1[i].ours + oursScores2[i].ours) / 2;
		const drh = (oursScores1[i].drh + oursScores2[i].drh) / 2;
		return { criterion, ours, drh, gap: drh - ours };
	});

	// Composite scores
	const oursComposite = perCriterion.reduce(
		(sum, s) => sum + RUBRIC_WEIGHTS[s.criterion] * s.ours, 0,
	);
	const drhComposite = perCriterion.reduce(
		(sum, s) => sum + RUBRIC_WEIGHTS[s.criterion] * s.drh, 0,
	);
	const ratio = drhComposite > 0 ? oursComposite / drhComposite : 0;

	// Unswap preferences
	const pref1 = unswapPreference(run1.preference, labels.run1);
	const pref2 = unswapPreference(run2.preference, labels.run2);
	const preferenceRuns = [pref1, pref2];

	// Gate checks — per-run, NOT averaged (§5: "in either run")
	// Check BOTH runs' raw scores against the floor, not the average.
	const criticalFailures = CRITERIA
		.filter((c) => c === "factual_accuracy" || c === "citation_integrity")
		.filter((criterion) => {
			const idx = CRITERIA.indexOf(criterion);
			return oursScores1[idx].ours < threshold.critical_floor ||
			       oursScores2[idx].ours < threshold.critical_floor;
		});

	const collapsedCriteria = CRITERIA
		.filter((c) => c !== "factual_accuracy" && c !== "citation_integrity")
		.filter((criterion) => {
			const idx = CRITERIA.indexOf(criterion);
			return oursScores1[idx].ours < threshold.hard_floor ||
			       oursScores2[idx].ours < threshold.hard_floor;
		});

	const drhStronglyPreferred =
		preferenceRuns.every((p) => p === "drh") &&
		run1.confidence === "high" && run2.confidence === "high";

	const pass =
		criticalFailures.length === 0 &&
		collapsedCriteria.length === 0 &&
		!drhStronglyPreferred &&
		ratio >= threshold.ratio;

	const rationale = pass
		? "Candidate meets quality bar (no critical failures, composite ≥ threshold of reference)"
		: [
			criticalFailures.length > 0 && `critical criteria below ${threshold.critical_floor}/5: ${criticalFailures.join(", ")}`,
			collapsedCriteria.length > 0 && `criteria below ${threshold.hard_floor}/5: ${collapsedCriteria.join(", ")}`,
			drhStronglyPreferred && "DRH strongly preferred in both runs (high confidence)",
			ratio < threshold.ratio && `composite ratio ${ratio.toFixed(2)} < ${threshold.ratio}`,
		].filter(Boolean).join("; ") || "Unknown failure";

	return {
		pass,
		ours_composite: oursComposite,
		drh_composite: drhComposite,
		ratio,
		critical_failures: criticalFailures as Criterion[],
		preference_runs: preferenceRuns,
		per_criterion: perCriterion,
		rationale,
		timestamp: new Date().toISOString(),
	};
}

function unswapScores(
	scores: CriterionScore[],
	runLabels: { A: string; B: string },
): Array<{ ours: number; drh: number }> {
	return scores.map((s) => ({
		ours: runLabels.A === "ours" ? s.score_a : s.score_b,
		drh: runLabels.A === "ours" ? s.score_b : s.score_a,
	}));
}

function unswapPreference(
	pref: "A" | "B" | "tie",
	runLabels: { A: string; B: string },
): "ours" | "drh" | "tie" {
	if (pref === "tie") return "tie";
	if (pref === "A") return runLabels.A === "ours" ? "ours" : "drh";
	return runLabels.B === "ours" ? "ours" : "drh";
}

// ── formatting ───────────────────────────────────────────────────────────

export function formatVerdict(v: Verdict): string {
	const lines: string[] = [];
	lines.push(`pass: ${v.pass ? "✅ YES" : "❌ NO"}`);
	lines.push(`ours: ${v.ours_composite.toFixed(2)} | drh: ${v.drh_composite.toFixed(2)} | ratio: ${(v.ratio * 100).toFixed(0)}%`);
	lines.push(`\nper-criterion:`);
	for (const s of v.per_criterion) {
		const gap = s.gap;
		const isCritical = s.criterion === "factual_accuracy" || s.criterion === "citation_integrity";
		const floor = isCritical ? 3 : 2;
		const flag = s.ours < floor ? " ❌CRITICAL" : gap > 1 ? " ⚠gap" : "";
		lines.push(`  ${s.criterion.padEnd(25)} ours=${s.ours.toFixed(1)} drh=${s.drh.toFixed(1)} gap=${gap >= 0 ? "+" : ""}${gap.toFixed(1)}${flag}`);
	}
	lines.push(`\n${v.rationale}`);
	return lines.join("\n");
}
