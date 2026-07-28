// test/extension.e2e.ts — REAL Pi-harness E2E (layer 2).
//
// This tests the FULL stack: Pi loads the extension, the model discovers
// dr_research, decides to call it, the tool runs, artifacts land on disk.
// NOT the orchestrator directly (that's test/e2e.ts, layer 3).
//
// Per DRH guidance: two test layers, this is the agent-loop one.
//
//   MODEL_REF="zai/glm-4.5-air" bun test/extension.e2e.ts

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunStore } from "../src/store.ts";
import { computeMetrics } from "../src/metrics.ts";

const TOPIC = "What is the current capital cost per kW of small modular reactors?";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!cond) failures++;
}

// ── setup ────────────────────────────────────────────────────────────────
const cwd = await mkdtemp(join(tmpdir(), "pi-dr-ext-"));
const extPath = resolve(process.cwd(), "extensions/research.ts");
check("extension file exists", existsSync(extPath));

const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();
check("models available", available.length > 0, `${available.length}`);
const model = available.find((m) => `${m.provider}/${m.id}` === process.env.MODEL_REF) ?? available[0];
console.log(`   model: ${model.provider}/${model.id}`);

// ── load our extension into a real Pi session ────────────────────────────
const loader = new DefaultResourceLoader({
	additionalExtensionPaths: [extPath],
	cwd,
});
await loader.reload();

const extensions = loader.getExtensions();
check("extension loaded by ResourceLoader", extensions.some((e) => e.name?.includes("deep-research") || e.path?.includes("research.ts")));

const { session } = await createAgentSession({
	cwd,
	resourceLoader: loader,
	modelRuntime: runtime,
	sessionManager: SessionManager.inMemory(cwd),
	model,
});

// ── capture all events ───────────────────────────────────────────────────
const events: AgentSessionEvent[] = [];
const unsubscribe = session.subscribe((event) => {
	events.push(event);
	if (event.type === "tool_execution_start") {
		console.log(`   ▸ TOOL CALL: ${event.toolName}`);
	}
	if (event.type === "tool_execution_end" && event.isError) {
		console.log(`   ✗ TOOL ERROR: ${event.toolName}`);
	}
});

// ── positive test: agent should call dr_research ─────────────────────────
console.log("\n=== POSITIVE: agent discovers and calls dr_research ===");
await session.prompt(
	`You are testing a research extension. Use the dr_research tool to research: "${TOPIC}". ` +
		`Pass profile: "quick". Do NOT answer from memory — you MUST actually call the dr_research tool. ` +
		`When it completes, briefly tell me how many sources and claims it found.`,
);

unsubscribe();

const toolStarts = events.filter((e) => e.type === "tool_execution_start") as Array<{ toolName: string; args?: unknown }>;
const toolEnds = events.filter((e) => e.type === "tool_execution_end") as Array<{ toolName: string; result?: unknown; isError?: boolean; details?: unknown }>;

check("agent called at least one tool", toolStarts.length > 0, `${toolStarts.length} tool calls`);
check("agent called dr_research", toolStarts.some((t) => t.toolName === "dr_research"));

const drResult = toolEnds.find((t) => t.toolName === "dr_research");
check("dr_research succeeded (no error)", drResult && !drResult.isError);

// ── verify artifacts on disk (the artifact contract) ─────────────────────
if (drResult) {
	const details = (drResult as { details?: Record<string, unknown> }).details ?? {};
	const runId = details.run_id as string | undefined;
	const runDir = details.run_dir as string | undefined;

	check("tool returned run_id", !!runId);
	check("tool returned run_dir", !!runDir);

	if (runId) {
		const store = new RunStore(cwd, runId);
		check("run.json on disk", existsSync(store.metaFile()));
		check("report.md on disk", existsSync(store.reportFile()));
		check("audit.json on disk", existsSync(store.auditFile()));
		check("sources.json on disk", existsSync(store.sourcesFile()));
		check("evidence.jsonl on disk", existsSync(store.evidenceFile()));
		check("claims.json on disk", existsSync(store.claimsFile()));

		// compute metrics from artifacts
		const meta = await store.loadMeta();
		const sources = await store.loadSources();
		const evidence = await store.loadEvidence();
		const claims = await store.loadClaims();
		const edges = await store.loadEdges();
		const audit = JSON.parse(await readFile(store.auditFile()));
		if (meta?.spec) {
			const m = computeMetrics(meta.spec, sources, evidence, claims, edges, audit);
			console.log(`\n   metrics: ${sources.length} sources, ${evidence.length} evidence, ${claims.length} claims, ${(m.corroboratedFraction * 100).toFixed(0)}% corroboration`);
		}
	}
}

// ── negative test: agent should NOT research when told not to ────────────
console.log("\n=== NEGATIVE: agent does NOT call dr_research unprompted ===");
const { session: session2 } = await createAgentSession({
	cwd,
	resourceLoader: loader,
	modelRuntime: runtime,
	sessionManager: SessionManager.inMemory(cwd),
	model,
});
const negEvents: AgentSessionEvent[] = [];
const unsub2 = session2.subscribe((e) => negEvents.push(e));
await session2.prompt("What is 2+2? Answer briefly. Do NOT use any tools.");
unsub2();

const negToolCalls = negEvents.filter((e) => e.type === "tool_execution_start");
check("negative: no tools called when told not to", negToolCalls.length === 0, `${negToolCalls.length} tool calls`);

console.log(`\n${failures === 0 ? "✅ EXTENSION E2E PASSED" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

// helper
async function readFile(path: string): Promise<string> {
	return await import("node:fs/promises").then((m) => m.readFile(path, "utf8"));
}
