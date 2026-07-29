// test/gate/verdict.ts — verdict computation and pass/fail gate.
//
// Thin re-export of the aggregation logic from runners/juror.ts,
// plus the applyGate function for independent gate enforcement.
//
// The actual aggregation lives in runners/juror.ts because it needs
// the label-unswap logic that's tightly coupled to juror run parsing.
// This module provides the gate-application interface for suites.

import type { Verdict, Threshold } from "../lib/types.ts";
import { aggregateVerdict as aggregate, formatVerdict as format } from "../runners/juror.ts";
import type { JurorRun, JurorLabels } from "../lib/types.ts";

export { aggregate, format };

/**
// Re-check a verdict against a (possibly different) threshold.
// Useful for threshold calibration without re-aggregating.
//
// NOTE: The per-run floor checks (critical_failures, collapsed criteria)
// are computed by aggregateVerdict at aggregation time using RAW per-run
// scores (§5: "in either run"). applyGate cannot re-check these because
// the Verdict type only stores averaged scores. applyGate re-checks only
// the ratio threshold, which is the value that calibration adjusts.
// The critical_failures from the original aggregation are preserved.
 */
export function applyGate(verdict: Verdict, threshold: Threshold): Verdict {
	// Preserve original per-run floor check results (computed at aggregation time)
	const criticalFailures = verdict.critical_failures;

	// Re-check ratio against new threshold
	const ratioPass = verdict.ratio >= threshold.ratio;

	// DRH strongly preferred is a structural check, doesn't depend on threshold
	const drhStronglyPreferred = verdict.preference_runs.every((p) => p === "drh");

	const pass = criticalFailures.length === 0 && ratioPass && !drhStronglyPreferred;

	return {
		...verdict,
		pass,
		rationale: pass
			? "Candidate meets quality bar"
			: `Gate failure: ${[
				criticalFailures.length > 0 && `critical criteria failed: ${criticalFailures.join(", ")}`,
				drhStronglyPreferred && "DRH strongly preferred in both runs",
				!ratioPass && `ratio ${verdict.ratio.toFixed(2)} < ${threshold.ratio}`,
			].filter(Boolean).join("; ")}`,
	};
}

/**
// Compute the composite score from per-criterion scores.
 */
export function compositeFromScores(
	scores: Record<string, number>,
	weights: Record<string, number>,
): number {
	return Object.entries(weights).reduce(
		(sum, [criterion, weight]) => sum + weight * (scores[criterion] ?? 0), 0,
	);
}
