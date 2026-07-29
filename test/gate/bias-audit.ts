// test/gate/bias-audit.ts — periodic bias detection (§6.1).
//
// Checks historical verdicts for systematic bias patterns:
// - Verbosity bias: longer reports consistently scoring higher
// - Central tendency: scores clustering at 3/5
// - Citation spam reward: more citations → higher source_quality
//
// Run this every N autoresearch iterations (§9.2 independent audit).

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BiasReport, Verdict } from "../lib/types.ts";

interface AuditDataPoint {
	verdict: Verdict;
	reportLength: number; // word count
	citationCount: number;
}

/**
// Run all bias checks against historical data.
 */
export async function auditBiases(dataDir: string): Promise<BiasReport[]> {
	const dataPoints = await loadDataPoints(dataDir);
	if (dataPoints.length < 5) {
		return [{
			bias: "none",
			detected: false,
			detail: `Insufficient data for bias audit (${dataPoints.length} < 5 verdicts)`,
			severity: "low",
		}];
	}

	return [
		checkVerbosityBias(dataPoints),
		checkCentralTendency(dataPoints),
		checkCitationSpam(dataPoints),
	];
}

/**
// Verbosity bias: longer reports consistently scoring higher (§6).
// Correlation between report length and composite score.
 */
export function checkVerbosityBias(data: AuditDataPoint[]): BiasReport {
	if (data.length < 5) {
		return { bias: "verbosity", detected: false, detail: "insufficient data", severity: "low" };
	}

	const correlation = pearsonCorrelation(
		data.map((d) => d.reportLength),
		data.map((d) => d.verdict.ours_composite),
	);

	const detected = correlation > 0.6;
	return {
		bias: "verbosity",
		detected,
		detail: `length-score correlation: ${correlation.toFixed(2)} ${detected ? "(⚠ strong positive — longer reports score higher)" : "(OK)"}`,
		severity: detected ? (correlation > 0.8 ? "high" : "medium") : "low",
	};
}

/**
// Central tendency: scores clustering at 3/5 (judge isn't discriminating).
 */
export function checkCentralTendency(data: AuditDataPoint[]): BiasReport {
	if (data.length < 5) {
		return { bias: "central_tendency", detected: false, detail: "insufficient data", severity: "low" };
	}

	// Collect all per-criterion scores
	const allScores: number[] = [];
	for (const d of data) {
		for (const pc of d.verdict.per_criterion) {
			allScores.push(pc.ours);
		}
	}

	const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
	const variance = allScores.reduce((a, b) => a + (b - mean) ** 2, 0) / allScores.length;
	const stdDev = Math.sqrt(variance);

	// Low std dev + mean near 3 = central tendency
	const detected = stdDev < 0.5 && Math.abs(mean - 3) < 0.5;
	return {
		bias: "central_tendency",
		detected,
		detail: `mean=${mean.toFixed(2)}, stdDev=${stdDev.toFixed(2)} ${detected ? "(⚠ scores clustered at 3 — judge not discriminating)" : "(OK)"}`,
		severity: detected ? "medium" : "low",
	};
}

/**
// Citation spam reward: more citations → higher source_quality score.
 */
export function checkCitationSpam(data: AuditDataPoint[]): BiasReport {
	if (data.length < 5) {
		return { bias: "citation_spam", detected: false, detail: "insufficient data", severity: "low" };
	}

	const correlations = data.map((d) => {
		const sourceQuality = d.verdict.per_criterion.find((p) => p.criterion === "source_quality")?.ours ?? 3;
		return { citations: d.citationCount, score: sourceQuality };
	});

	const correlation = pearsonCorrelation(
		correlations.map((c) => c.citations),
		correlations.map((c) => c.score),
	);

	const detected = correlation > 0.7;
	return {
		bias: "citation_spam",
		detected,
		detail: `citation-count vs source_quality correlation: ${correlation.toFixed(2)} ${detected ? "(⚠ more citations = higher score)" : "(OK)"}`,
		severity: detected ? "medium" : "low",
	};
}

// ── helpers ──────────────────────────────────────────────────────────────

function pearsonCorrelation(x: number[], y: number[]): number {
	const n = x.length;
	if (n !== y.length || n === 0) return 0;

	const sumX = x.reduce((a, b) => a + b, 0);
	const sumY = y.reduce((a, b) => a + b, 0);
	const sumXY = x.reduce((a, _, i) => a + x[i] * y[i], 0);
	const sumX2 = x.reduce((a, b) => a + b * b, 0);
	const sumY2 = y.reduce((a, b) => a + b * b, 0);

	const numerator = n * sumXY - sumX * sumY;
	const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

	return denominator === 0 ? 0 : numerator / denominator;
}

async function loadDataPoints(dataDir: string): Promise<AuditDataPoint[]> {
	// Walk test/results/<topic>/ directories, load verdict.json + report length
	const points: AuditDataPoint[] = [];

	if (!existsSync(dataDir)) return points;

	const topics = await readdir(dataDir, { withFileTypes: true });
	for (const topic of topics) {
		if (!topic.isDirectory()) continue;
		const topicPath = join(dataDir, topic.name);
		const verdictPath = join(topicPath, "verdict.json");
		const reportPath = join(topicPath, "ours_report.md");

		if (!existsSync(verdictPath) || !existsSync(reportPath)) continue;

		try {
			const verdict = JSON.parse(await readFile(verdictPath, "utf8")) as Verdict;
			const report = await readFile(reportPath, "utf8");
			points.push({
				verdict,
				reportLength: report.split(/\s+/).length,
				citationCount: (report.match(/\[[\d,]+\]/g) || []).length,
			});
		} catch {
			// skip malformed
		}
	}

	return points;
}

/**
// Format a bias audit report for display.
 */
export function formatBiasReport(reports: BiasReport[]): string {
	const lines: string[] = ["=== BIAS AUDIT ==="];
	for (const r of reports) {
		const icon = r.detected ? "⚠" : "✓";
		lines.push(`${icon} ${r.bias}: ${r.detail}`);
	}
	const anyDetected = reports.some((r) => r.detected);
	if (anyDetected) {
		lines.push("\n⚠ Bias detected — consider adjusting rubric weights, adding few-shot anchors, or switching to ensemble judging.");
	} else {
		lines.push("\n✓ No systematic bias detected.");
	}
	return lines.join("\n");
}
