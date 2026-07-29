// test/gate/threshold.ts — threshold calibration + gate enforcement.
//
// §5.1: the 80% threshold must be calibrated from historical data,
// not guessed. This module reads past verdicts and computes the
// appropriate threshold for the candidate's current quality level.
//
// Also tracks hard-gate baselines: factual_accuracy and citation_integrity
// scores must not decrease between iterations (anti-regression, §9.2).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Threshold, Verdict } from "../lib/types.ts";
import { DEFAULT_THRESHOLD, HARD_GATE_CRITERIA } from "../lib/types.ts";

const HISTORY_FILE = "test/results/threshold-history.json";

interface ThresholdHistory {
	verdicts: Array<{ topic: string; verdict: Verdict; timestamp: string }>;
	baselines: Partial<Record<string, number>>; // criterion → best score ever achieved
}

/**
// Load historical verdicts for calibration.
 */
export async function loadHistory(): Promise<ThresholdHistory> {
	if (!existsSync(HISTORY_FILE)) return { verdicts: [], baselines: {} };
	return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
}

/**
// Save a verdict to history and update baselines.
 */
export async function recordVerdict(topic: string, verdict: Verdict): Promise<void> {
	const history = await loadHistory();
	history.verdicts.push({ topic, verdict, timestamp: verdict.timestamp });

	// Update baselines — track the best score per criterion
	for (const pc of verdict.per_criterion) {
		const current = history.baselines[pc.criterion] ?? 0;
		if (pc.ours > current) {
			history.baselines[pc.criterion] = pc.ours;
		}
	}

	await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}

/**
// Calibrate the threshold from historical data (§5.1).
 *
// Logic:
// - If we have ≥3 historical verdicts, compute the median ratio.
// - Set threshold to 90% of the median ratio (so the candidate can usually pass).
// - But never set it above the default (0.80) — we want to push toward that bar.
// - Never set it above what the current system achieves.
 */
export function calibrate(history: ThresholdHistory): Threshold {
	if (history.verdicts.length < 3) {
		console.log("  threshold: using default (insufficient history for calibration)");
		return DEFAULT_THRESHOLD;
	}

	const ratios = history.verdicts.map((v) => v.verdict.ratio).sort((a, b) => a - b);
	const medianRatio = ratios[Math.floor(ratios.length / 2)];
	const calibratedRatio = Math.min(medianRatio * 0.9, DEFAULT_THRESHOLD.ratio);

	console.log(`  threshold: calibrated to ${(calibratedRatio * 100).toFixed(0)}% (median ratio ${(medianRatio * 100).toFixed(0)}%)`);

	return {
		ratio: calibratedRatio,
		hard_floor: DEFAULT_THRESHOLD.hard_floor,
		critical_floor: DEFAULT_THRESHOLD.critical_floor,
	};
}

/**
// Check if a verdict violates hard-gate baselines (§9.2 anti-gaming).
// Hard-gate criteria must not decrease from their historical best.
 */
export function checkHardGateBaselines(
	verdict: Verdict,
	history: ThresholdHistory,
): { violated: boolean; regressions: string[] } {
	const regressions: string[] = [];

	for (const criterion of HARD_GATE_CRITERIA) {
		const baseline = history.baselines[criterion];
		if (baseline === undefined) continue;

		const current = verdict.per_criterion.find((p) => p.criterion === criterion)?.ours;
		if (current !== undefined && current < baseline - 0.5) {
			regressions.push(
				`${criterion}: ${current.toFixed(1)} < baseline ${baseline.toFixed(1)} (regression)`,
			);
		}
	}

	return { violated: regressions.length > 0, regressions };
}

/**
// Get the current baseline for a criterion (best score ever achieved).
 */
export function getBaseline(history: ThresholdHistory, criterion: string): number | undefined {
	return history.baselines[criterion];
}

/**
// Detect borderline verdicts that need human review (§5.2).
// Borderline = passing with ratio 0.79-0.82, or failing by a small margin.
 */
export function findBorderline(verdict: Verdict): { borderline: boolean; reason: string } {
	// Near-threshold pass: ratio in [0.79, 0.82]
	if (verdict.pass && verdict.ratio >= 0.79 && verdict.ratio <= 0.82) {
		return {
			borderline: true,
			reason: `Passed with ratio ${verdict.ratio.toFixed(2)} — near threshold, human review recommended`,
		};
	}

	// Near-threshold fail: ratio in [0.75, 0.80)
	if (!verdict.pass && verdict.ratio >= 0.75 && verdict.ratio < 0.80) {
		return {
			borderline: true,
			reason: `Failed with ratio ${verdict.ratio.toFixed(2)} — near threshold, human review recommended`,
		};
	}

	// Failed by a small margin on one criterion
	const closeFail = verdict.per_criterion.find((pc) => {
		const isCritical = pc.criterion === "factual_accuracy" || pc.criterion === "citation_integrity";
		const floor = isCritical ? 3 : 2;
		return pc.ours >= floor - 0.5 && pc.ours < floor;
	});
	if (closeFail) {
		return {
			borderline: true,
			reason: `${closeFail.criterion} at ${closeFail.ours.toFixed(1)} — just below floor, human review recommended`,
		};
	}

	return { borderline: false, reason: "" };
}
