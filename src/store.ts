// src/store.ts — durable research run state.
//
// The reference design's #1 principle: the context window is temporary working
// memory; durable research state lives outside it. This is that external store.
// Each run is a directory under .pi/research/<runId>/; every phase writes
// through to disk so an Esc/interruption never loses progress and a run can
// resume where it left off.

import { mkdir, writeFile, readFile, appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Spec {
	objective: string;
	audience?: string;
	geography?: string[];
	time_horizon?: string;
	dimensions: string[];
	source_policy?: { prefer_primary?: boolean; minimum_independent_support?: number };
	freshness?: { current_as_of?: string };
}

export interface Task {
	id: string;
	question: string;
	priority: number; // higher = sooner
	status: "open" | "in_progress" | "done" | "skipped";
	depth: number; // 0 = top-level subquestion, 1 = follow-up, ...
	completion_test?: string;
	depends_on?: string[]; // task ids that must complete first (§4 task graph)
	summary?: string; // task memo digest (tier 3)
}

export interface Source {
	id: string;
	url: string;
	title: string;
	publisher?: string;
	date?: string;
	quality: "high" | "medium" | "low" | "unknown";
	hash: string; // dedupe key
	fingerprint?: string; // simhash hex, for near-dup
	quality_features?: SourceQualityFeatures; // §10 multi-feature scoring
	url_canonical?: string;
}

export interface Evidence {
	id: string;
	task_id: string;
	source_id: string;
	claim: string;
	values?: Record<string, string | number>;
	conditions?: string;
	confidence: number; // 0..1
	quote?: string; // verbatim supporting snippet
}

export interface SourceQualityFeatures {
	institutional_authority: number;
	methodological_transparency: number;
	data_provenance: number;
	independence: number;
	recency: number;
	domain_relevance: number;
	conflict_of_interest_risk: number;
}

export interface Claim {
	id: string;
	text: string;
	status: string; // "high" | "moderate" | "low" | "unknown" | "contested"
	supporting_evidence: string[];
	contradicting_evidence: string[];
	assumptions: string[];
	confidence: number;
	citation_ready: boolean;
	evidence_ids: string[];
	source_ids: string[];
}

export type ClaimRelation = "supports" | "contradicts" | "qualifies" | "duplicate" | "derived";

export interface ClaimEdge {
	from: string; // claim id
	to: string; // claim id
	relation: ClaimRelation;
	reason?: string;
}

/** Tier-3 memo: findings for one task (§13.3). An index into evidence, never a replacement for it. */
export interface TaskMemo {
	task_id: string;
	key_findings: string[];
	limitations: string[];
	relevant_claims: string[]; // claim ids
	created_at: string;
}

/** Tier-2 source memo: purpose + key findings + limitations (§13.3). */
export interface SourceMemo {
	source_id: string;
	purpose: string;
	key_findings: string[];
	limitations: string[];
	relevant_claims: string[];
}

export interface RunMeta {
	id: string;
	topic: string;
	created_at: string;
	status: "running" | "completed" | "interrupted" | "failed";
	spec?: Spec;
	model?: string;
	config: ResearchConfig;
	stats: {
		searches: number;
		sources_ingested: number;
		evidence_extracted: number;
		iterations: number;
	};
}

export interface ResearchConfig {
	breadth: number; // sources per search round
	depth: number; // max follow-up depth
	max_sources: number; // hard cap on ingested sources
	max_iterations: number; // hard cap on loop iterations
	max_search_queries: number; // queries generated per task
}

export const DEFAULT_CONFIG: ResearchConfig = {
	breadth: 5,
	depth: 2,
	max_sources: 25,
	max_iterations: 12,
	max_search_queries: 4,
};

/** Depth profiles — user-facing scale knobs (liberation from fixed budgets). */
export const PROFILES: Record<string, Partial<ResearchConfig>> = {
	quick: { breadth: 4, max_sources: 10, max_iterations: 4, max_search_queries: 3, depth: 1 },
	standard: {},
	deep: { breadth: 6, max_sources: 40, max_iterations: 20, max_search_queries: 5, depth: 3 },
	heavy: { breadth: 8, max_sources: 60, max_iterations: 30, max_search_queries: 6, depth: 4 },
};

export class RunStore {
	readonly dir: string;
	constructor(
		public readonly cwd: string,
		public readonly runId: string,
	) {
		this.dir = join(cwd, ".pi", "research", runId);
	}

	metaFile() {
		return join(this.dir, "run.json");
	}
	tasksFile() {
		return join(this.dir, "tasks.json");
	}
	sourcesFile() {
		return join(this.dir, "sources.json");
	}
	evidenceFile() {
		return join(this.dir, "evidence.jsonl");
	}
	reportFile() {
		return join(this.dir, "report.md");
	}
	logFile() {
		return join(this.dir, "log.jsonl");
	}

	claimsFile() {
		return join(this.dir, "claims.json");
	}
	edgesFile() {
		return join(this.dir, "claim_edges.json");
	}
	taskMemosFile() {
		return join(this.dir, "task_memos.json");
	}
	sourceMemosFile() {
		return join(this.dir, "source_memos.json");
	}
	auditFile() {
		return join(this.dir, "audit.json");
	}

	rawDir() {
		return join(this.dir, "raw"); // Tier 0: immutable source archive (§13.1)
	}

	async init() {
		await mkdir(this.rawDir(), { recursive: true });
	}

	async loadMeta(): Promise<RunMeta | null> {
		try {
			const raw = await readFile(this.metaFile(), "utf8");
			return JSON.parse(raw) as RunMeta;
		} catch {
			return null;
		}
	}
	async saveMeta(meta: RunMeta) {
		await writeFile(this.metaFile(), JSON.stringify(meta, null, 2), "utf8");
	}

	async loadTasks(): Promise<Task[]> {
		try {
			const raw = await readFile(this.tasksFile(), "utf8");
			return JSON.parse(raw) as Task[];
		} catch {
			return [];
		}
	}
	async saveTasks(tasks: Task[]) {
		await writeFile(this.tasksFile(), JSON.stringify(tasks, null, 2), "utf8");
	}

	async loadSources(): Promise<Source[]> {
		try {
			const raw = await readFile(this.sourcesFile(), "utf8");
			return JSON.parse(raw) as Source[];
		} catch {
			return [];
		}
	}
	async saveSources(sources: Source[]) {
		await writeFile(this.sourcesFile(), JSON.stringify(sources, null, 2), "utf8");
	}

	/** Evidence is append-only jsonl — one record per extracted claim. */
	async appendEvidence(ev: Evidence) {
		await appendFile(this.evidenceFile(), JSON.stringify(ev) + "\n", "utf8");
	}
	async loadEvidence(): Promise<Evidence[]> {
		try {
			const raw = await readFile(this.evidenceFile(), "utf8");
			return raw
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as Evidence);
		} catch {
			return [];
		}
	}

	/** Tier 0: archive the raw document so re-extraction/citation audits never refetch. */
	async saveRawSource(sourceId: string, text: string) {
		await writeFile(join(this.rawDir(), `${sourceId}.md`), text, "utf8");
	}
	async loadRawSource(sourceId: string): Promise<string | null> {
		try {
			return await readFile(join(this.rawDir(), `${sourceId}.md`), "utf8");
		} catch {
			return null;
		}
	}

	async saveClaims(claims: Claim[]) {
		await writeFile(this.claimsFile(), JSON.stringify(claims, null, 2), "utf8");
	}
	async loadClaims(): Promise<Claim[]> {
		try {
			return JSON.parse(await readFile(this.claimsFile(), "utf8")) as Claim[];
		} catch {
			return [];
		}
	}

	async saveEdges(edges: ClaimEdge[]) {
		await writeFile(this.edgesFile(), JSON.stringify(edges, null, 2), "utf8");
	}
	async loadEdges(): Promise<ClaimEdge[]> {
		try {
			return JSON.parse(await readFile(this.edgesFile(), "utf8")) as ClaimEdge[];
		} catch {
			return [];
		}
	}

	async saveTaskMemos(memos: TaskMemo[]) {
		await writeFile(this.taskMemosFile(), JSON.stringify(memos, null, 2), "utf8");
	}
	async loadTaskMemos(): Promise<TaskMemo[]> {
		try {
			return JSON.parse(await readFile(this.taskMemosFile(), "utf8")) as TaskMemo[];
		} catch {
			return [];
		}
	}

	async saveSourceMemos(memos: SourceMemo[]) {
		await writeFile(this.sourceMemosFile(), JSON.stringify(memos, null, 2), "utf8");
	}
	async loadSourceMemos(): Promise<SourceMemo[]> {
		try {
			return JSON.parse(await readFile(this.sourceMemosFile(), "utf8")) as SourceMemo[];
		} catch {
			return [];
		}
	}

	async saveAudit(report: unknown) {
		await writeFile(this.auditFile(), JSON.stringify(report, null, 2), "utf8");
	}

	outlineFile() {
		return join(this.dir, "outline.json");
	}
	async saveOutline(outline: unknown) {
		await writeFile(this.outlineFile(), JSON.stringify(outline, null, 2), "utf8");
	}

	async saveReport(md: string) {
		await writeFile(this.reportFile(), md, "utf8");
	}

	/** Append a structured event to the decision log (gap detection, pivots, etc.). */
	async log(kind: string, details: Record<string, unknown>) {
		const entry = JSON.stringify({ ts: new Date().toISOString(), kind, ...details });
		await appendFile(this.logFile(), entry + "\n", "utf8");
	}

	/** All run ids for this project, newest-first by mtime. */
	static async list(cwd: string): Promise<string[]> {
		const root = join(cwd, ".pi", "research");
		try {
			const entries = await readdir(root, { withFileTypes: true });
			return entries.filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	}
}

/** Deterministic run id: timestamp + short topic slug. */
export function makeRunId(topic: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const slug =
		topic
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "research";
	return `${ts}-${slug}`;
}

/** Cheap content hash for dedup. */
export function hashContent(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
	return (h >>> 0).toString(16);
}
