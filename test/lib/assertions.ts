// test/lib/assertions.ts — domain-specific test assertions.
//
// One responsibility: throw with clear context when a condition fails.
// Used by suites to verify candidate run quality.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunMetrics } from "./types.ts";

export class TestAssertionError extends Error {
	constructor(
		message: string,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "TestAssertionError";
	}
}

export function assert(condition: boolean, message: string, details?: unknown): void {
	if (!condition) {
		throw new TestAssertionError(message, details);
	}
}

export function assertReportExists(runDir: string): void {
	assert(existsSync(join(runDir, "report.md")), "report.md not found in run directory", { runDir });
}

export function assertCitationsEntailed(metrics: RunMetrics, threshold = 0.75): void {
	assert(
		metrics.citationPassRate >= threshold,
		`Citation pass rate ${(metrics.citationPassRate * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}% threshold`,
		{ citationPassRate: metrics.citationPassRate, threshold },
	);
}

export function assertCoverage(metrics: RunMetrics, threshold = 0.80): void {
	const fraction = metrics.dimensionsTotal > 0
		? metrics.dimensionsCovered / metrics.dimensionsTotal
		: 0;
	assert(
		fraction >= threshold,
		`Coverage ${metrics.dimensionsCovered}/${metrics.dimensionsTotal} (${(fraction * 100).toFixed(0)}%) < ${(threshold * 100).toFixed(0)}% threshold`,
		{ dimensionsCovered: metrics.dimensionsCovered, dimensionsTotal: metrics.dimensionsTotal, threshold },
	);
}

export function assertCorroboration(metrics: RunMetrics, threshold = 0.10): void {
	assert(
		metrics.corroboratedFraction >= threshold,
		`Corroboration ${(metrics.corroboratedFraction * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}% threshold`,
		{ corroboratedFraction: metrics.corroboratedFraction, threshold },
	);
}

export function assertSourcesSufficient(metrics: RunMetrics, min = 10): void {
	assert(
		metrics.sources >= min,
		`Only ${metrics.sources} sources (< ${min} minimum)`,
		{ sources: metrics.sources },
	);
}

export function assertNoCriticalFailures(metrics: RunMetrics): void {
	const issues: string[] = [];
	if (metrics.citationPassRate < 0.5) issues.push(`citation pass rate critically low (${(metrics.citationPassRate * 100).toFixed(0)}%)`);
	if (metrics.dimensionsCovered === 0 && metrics.dimensionsTotal > 0) issues.push("zero dimensions covered");
	if (metrics.sources < 3) issues.push(`only ${metrics.sources} sources`);
	assert(issues.length === 0, `Critical failures: ${issues.join("; ")}`, issues);
}
