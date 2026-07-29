// test/lib/types.ts — shared types for the E2E judge framework.
//
// Every file in test/{lib,runners,gate,suites} imports from here.
// No runtime code — pure type definitions.

// ── rubric (9 criteria, DRH-reviewed, §4) ────────────────────────────────

export const RUBRIC_WEIGHTS = {
	factual_accuracy: 0.20,
	citation_integrity: 0.20,
	source_quality: 0.15,
	coverage: 0.15,
	contradiction_handling: 0.10,
	analytical_depth: 0.05,
	timeliness: 0.05,
	structure_actionability: 0.05,
	conciseness: 0.05,
} as const;

export type Criterion = keyof typeof RUBRIC_WEIGHTS;

export const CRITERIA: Criterion[] = Object.keys(RUBRIC_WEIGHTS) as Criterion[];

/** Criteria that cannot drop below 3/5 — hard gates (§5). */
export const HARD_GATE_CRITERIA: Criterion[] = ["factual_accuracy", "citation_integrity"];

// ── juror types ──────────────────────────────────────────────────────────

export interface CriterionScore {
	criterion: Criterion;
	score_a: number; // 1-5
	score_b: number; // 1-5
	justification: string;
}

export interface JurorRun {
	scores: CriterionScore[];
	composite_a?: number; // juror-computed weighted sum (0-5)
	composite_b?: number;
	preference: "A" | "B" | "tie";
	confidence: "high" | "medium" | "low";
	key_strengths_a: string[];
	key_weaknesses_a: string[];
	key_strengths_b: string[];
	key_weaknesses_b: string[];
}

/** Which report is labeled A vs B in each run (anti-position-bias swap). */
export interface JurorLabels {
	run1: { A: "ours" | "drh"; B: "ours" | "drh" };
	run2: { A: "ours" | "drh"; B: "ours" | "drh" };
}

// ── verdict ──────────────────────────────────────────────────────────────

export interface PerCriterionResult {
	criterion: Criterion;
	ours: number; // averaged across swapped runs
	drh: number;
	gap: number; // drh - ours (positive = drh better)
}

export interface Verdict {
	pass: boolean;
	ours_composite: number;
	drh_composite: number;
	ratio: number;
	critical_failures: Criterion[];
	preference_runs: Array<"A" | "B" | "tie">;
	per_criterion: PerCriterionResult[];
	rationale: string;
	timestamp: string;
}

// ── test config ──────────────────────────────────────────────────────────

export interface TestConfig {
	topic: string;
	profile: "quick" | "standard" | "deep" | "heavy" | "ultra";
	model?: string; // candidate model, e.g. "zai/glm-4.5-air"
	ttl_days?: number; // reference cache TTL (§3.2)
	expected_dimensions?: string[];
}

// ── candidate result ─────────────────────────────────────────────────────

export interface CandidateResult {
	report: string;
	runDir: string; // .pi/research/<runId> in the session cwd
	metrics: RunMetrics | null;
	wordCount: number;
}

// Re-export the ResearchMetrics type from src for convenience
export interface RunMetrics {
	sources: number;
	independentPublishers: number;
	evidenceRecords: number;
	claims: number;
	claimsCitationReady: number;
	corroboratedClaims: number;
	corroboratedFraction: number;
	contradictionsDetected: number;
	contradictionsAcknowledged: boolean;
	dimensionsCovered: number;
	dimensionsTotal: number;
	citationPassRate: number;
	publisherConcentration: number;
}

// ── gate / threshold ─────────────────────────────────────────────────────

export interface Threshold {
	ratio: number; // candidate/reference composite ratio (default 0.80)
	hard_floor: number; // minimum score for any criterion (default 2)
	critical_floor: number; // minimum for hard-gate criteria (default 3)
}

export const DEFAULT_THRESHOLD: Threshold = {
	ratio: 0.80,
	hard_floor: 2,
	critical_floor: 3,
};

// ── bias audit ───────────────────────────────────────────────────────────

export interface BiasReport {
	bias: "verbosity" | "central_tendency" | "citation_spam" | "none";
	detected: boolean;
	detail: string;
	severity: "low" | "medium" | "high";
}

// ── health check ─────────────────────────────────────────────────────────

export interface HealthStatus {
	extensions: string[];
	models: number;
	apiKeys: { exa: boolean; scrapegraph: boolean };
	drhQuota: number | null; // null if not checked
	ok: boolean;
	issues: string[];
}
