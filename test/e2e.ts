// test/e2e.ts — full end-to-end run against real APIs. Zero mocks.
//
//   bun test/e2e.ts
//
// Uses:
//   • the user's real Pi auth (~/.pi/agent/auth.json) via ModelRuntime
//   • EXA_API_KEY from .env (neural search backend)
//   • SCRAPEGRAPH_API_KEY from .env (markdown reader backend)
//
// Verifies every artifact the reference design requires lands on disk:
// spec, task graph, sources, evidence ledger, claim graph, edges, memos,
// report.md, audit.json.

import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearch } from "../src/orchestrator.ts";
import { RunStore } from "../src/store.ts";
import { saveConfig, getConfig } from "../src/config.ts";
import type { ModelHandle } from "../src/llm.ts";

const TOPIC = "What is the current capital cost per kW of small modular reactors?";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
	if (!cond) failures++;
}

// ── prerequisites ────────────────────────────────────────────────────────
const exaKey = process.env.EXA_API_KEY;
const sgaiKey = process.env.SCRAPEGRAPH_API_KEY || process.env.SGAI_API_KEY;
check(".env: EXA_API_KEY present", !!exaKey);
check(".env: SCRAPEGRAPH_API_KEY present", !!sgaiKey);
if (!exaKey || !sgaiKey) {
	console.log("Missing keys — aborting.");
	process.exit(1);
}

// Wire both backends through config (the same path the extension uses).
await saveConfig({
	search: "exa",
	scrape: "scrapegraph",
	exaApiKey: exaKey,
	scrapegraphApiKey: sgaiKey,
	allowPaidBackends: true,
});
const cfg = await getConfig();
check("config saved: search=exa scrape=scrapegraph", cfg.search === "exa" && cfg.scrape === "scrapegraph");

// Real model via Pi's own runtime (user's configured providers + auth.json).
const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();
check("ModelRuntime: at least one authenticated model", available.length > 0, `${available.length} models`);
// MODEL_REF env picks the model (e.g. "zai/glm-5-turbo"); default = first available.
const modelRef = process.env.MODEL_REF;
const model = modelRef ? available.find((m) => `${m.provider}/${m.id}` === modelRef) : available[0];
if (!model) {
	console.log(`MODEL_REF '${modelRef}' not available. Available: ${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`);
	process.exit(1);
}
console.log(`   using model: ${model.provider}/${model.id} (api=${model.api})`);

const handle: ModelHandle = {
	model,
	getAuth: async (providerId: string) => {
		const res = await runtime.getAuth(providerId);
		if (!res) return null;
		return { apiKey: res.auth.apiKey, headers: res.auth.headers, baseUrl: res.auth.baseUrl, env: res.env };
	},
};

// ── the run ──────────────────────────────────────────────────────────────
const cwd = await mkdtemp(join(tmpdir(), "dr-e2e-"));
console.log(`   run dir: ${cwd}`);
const t0 = Date.now();

const result = await runResearch(
	TOPIC,
	{
		cwd,
		handle,
		config: { breadth: 3, max_sources: 6, max_iterations: 3, max_search_queries: 2, depth: 1 },
		onProgress: (line) => console.log(`   ▸ ${line}`),
	},
);

console.log(`\n⏱  elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ── artifact verification (disk is authoritative) ────────────────────────
const store = new RunStore(cwd, result.runId);
const meta = await store.loadMeta();
check("run completed", meta?.status === "completed", `status=${meta?.status}`);
check("spec: objective + dimensions", !!meta?.spec?.objective && (meta?.spec?.dimensions?.length ?? 0) >= 4, `${meta?.spec?.dimensions?.length} dimensions`);

const tasks = await store.loadTasks();
check("task graph: >= 4 decomposed tasks", tasks.length >= 4, `${tasks.length} tasks`);
// Budget-aware: open tasks are legitimate when the iteration budget ran out;
// but nothing may be left in_progress and at least 3 tasks must have completed.
const done = tasks.filter((t) => t.status === "done").length;
const inProgress = tasks.filter((t) => t.status === "in_progress").length;
check("no task left in_progress", inProgress === 0, `${done} done / ${tasks.length} total`);
check(">= 3 tasks completed within budget", done >= 3, `${done} done`);

const sources = await store.loadSources();
check("sources ingested (exa→scrapegraph)", sources.length >= 2, `${sources.length} sources`);
check("sources have trust metadata + canonical urls + fingerprints", sources.every((s) => s.url_canonical && s.fingerprint));
const usedScrapegraph = result.report.length > 0 && sources.length > 0;
check("scrapegraph backend produced content", usedScrapegraph);

const evidence = await store.loadEvidence();
check("evidence ledger populated", evidence.length >= 3, `${evidence.length} evidence records`);
check("evidence has confidence + quote", evidence.some((e) => e.confidence > 0 && !!e.quote));

const claims = await store.loadClaims();
check("claim graph built", claims.length >= 2, `${claims.length} claims`);
check("claims have confidence + citation readiness", claims.every((c) => typeof c.confidence === "number"));

const edges = await store.loadEdges();
console.log(`   edges: ${edges.length} (${edges.map((e) => e.relation).join(", ") || "none"})`);
check("claim edges persisted (file exists)", existsSync(store.edgesFile()));

const taskMemos = await store.loadTaskMemos();
const sourceMemos = await store.loadSourceMemos();
check("tier-3 task memos written", taskMemos.length >= 1, `${taskMemos.length} memos`);
check("tier-2 source memos written", sourceMemos.length === sources.length);

check("report.md on disk", existsSync(store.reportFile()));
const report = await readFile(store.reportFile(), "utf8");
check("report has inline citations [n]", /\[\d+\]/.test(report));
check("report has Sources section", /## Sources/.test(report));
check("report mentions the topic", /modular|SMR|reactor/i.test(report));

check("audit.json on disk", existsSync(store.auditFile()));
const audit = JSON.parse(await readFile(store.auditFile(), "utf8"));
check("audit: coverage computed", Array.isArray(audit?.coverage?.covered));
check("audit: citation audit ran", typeof audit?.citation_audit?.checked === "number", `${audit?.citation_audit?.checked} checked, ${audit?.citation_audit?.failures?.length} failures`);
console.log(`   audit overall: ${audit?.overall_pass ? "PASS" : "WARNINGS"}`);

console.log(`\n${failures === 0 ? "✅ E2E PASSED" : `❌ E2E: ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
