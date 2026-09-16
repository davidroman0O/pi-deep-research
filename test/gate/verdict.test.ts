import { expect, test } from "bun:test";
import { aggregateVerdict } from "../runners/juror.ts";
import { RUBRIC_WEIGHTS, type JurorRun, type JurorLabels } from "../lib/types.ts";

// Reproduces the run-48 shape that prompted the provenance requirement:
// juror 1 self-reported composite_a = 3.75 while the aggregated ours_composite
// was 3.50. Not a bug: aggregateVerdict computes a rubric-weighted mean of
// PER-CRITERION cross-run averages, which legitimately differs from either
// juror's own weighted self-summary. This test pins the formula.

const scores1 = {
  factual_accuracy: [4, 5], citation_integrity: [3, 4], source_quality: [4, 5],
  coverage: [4, 5], contradiction_handling: [4, 5], analytical_depth: [4, 5],
  timeliness: [4, 5], structure_actionability: [5, 5], conciseness: [2, 3],
} as Record<string, [number, number]>;

const scores2 = {
  factual_accuracy: [5, 3], citation_integrity: [5, 3], source_quality: [5, 3],
  coverage: [5, 3], contradiction_handling: [5, 3], analytical_depth: [5, 4],
  timeliness: [5, 5], structure_actionability: [5, 4], conciseness: [2, 4],
} as Record<string, [number, number]>;

const criteria = Object.keys(RUBRIC_WEIGHTS);
function toRun(scores: Record<string, [number, number]>, compositeA: number, compositeB: number, preference: "A" | "B" | "tie"): JurorRun {
  return {
    scores: criteria.map(c => ({ criterion: c as JurorRun["scores"][0]["criterion"], score_a: scores[c][0], score_b: scores[c][1], justification: "" })),
    composite_a: compositeA, composite_b: compositeB,
    preference, confidence: "high",
    key_strengths_a: [], key_weaknesses_a: [], key_strengths_b: [], key_weaknesses_b: [],
  };
}

const labels: JurorLabels = { run1: { A: "ours", B: "drh" }, run2: { A: "drh", B: "ours" } };
const run1 = toRun(scores1, 3.75, 4.70, "B");
const run2 = toRun(scores2, 4.85, 3.25, "A");

test("ours_composite reconstructs exactly from per-criterion cross-run averages + weights", () => {
  const verdict = aggregateVerdict(run1, run2, labels);
  const recomputed = verdict.per_criterion.reduce((s, pc) => s + RUBRIC_WEIGHTS[pc.criterion] * pc.ours, 0);
  expect(verdict.ours_composite).toBeCloseTo(recomputed, 10);
  const recomputedDrh = verdict.per_criterion.reduce((s, pc) => s + RUBRIC_WEIGHTS[pc.criterion] * pc.drh, 0);
  expect(verdict.drh_composite).toBeCloseTo(recomputedDrh, 10);
});

test("juror self-composites legitimately differ from the aggregation formula (3.75 vs 3.50 case)", () => {
  const verdict = aggregateVerdict(run1, run2, labels);
  // per-criterion ours averages: 3.5, 4.0, 3.5, 3.5, 3.5, 4.5, 4.5, 4.5, 3.0
  expect(verdict.per_criterion.find(p => p.criterion === "factual_accuracy")!.ours).toBe(3.5);
  // rubric-weighted aggregate is NOT the juror's self-reported 3.75:
  expect(verdict.ours_composite).not.toBe(3.75);
  // and the provenance block explains the difference
  expect(verdict.provenance?.formula).toContain("per-criterion");
  expect(verdict.provenance?.run_composites[0].composite_a).toBe(3.75);
});

test("drhStronglyPreferred fails the gate when both high-confidence runs prefer drh", () => {
  const verdict = aggregateVerdict(run1, run2, labels);
  expect(JSON.stringify(verdict.preference_runs)).toBe(JSON.stringify(["drh", "drh"]));
  expect(verdict.pass).toBe(false);
  expect(verdict.rationale).toContain("DRH strongly preferred");
});