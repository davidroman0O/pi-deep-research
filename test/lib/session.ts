// test/lib/session.ts — fresh Pi session factory + health checks.
//
// Creates isolated sessions for candidate runs. Verifies the environment
// before any long-running test (§2.3 health checks).

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	getAgentDir,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../../src/config.ts";
import type { HealthStatus } from "./types.ts";

/**
// Check DRH quota via pi-gpt's BackendClient (§2.3 health check).
// Returns remaining quota or null if unavailable.
 */
export async function checkDrhQuota(): Promise<number | null> {
	try {
		const { join } = await import("node:path");
		const clientPath = join(getAgentDir(), "npm", "node_modules", "pi-gpt", "src", "client.ts");
		const { BackendClient } = await import(clientPath);
		const backend = new BackendClient();
		const init: any = await backend.post("/backend-api/conversation/init", {
			conversation_mode_kind: "primary_assistant",
		});
		const limit = (init?.limits_progress || []).find(
			(item: any) => item?.feature_name === "deep_research",
		);
		return limit?.remaining ?? null;
	} catch {
		return null;
	}
}

export interface SessionHandle {
	session: ReturnType<typeof createAgentSession> extends Promise<infer T> ? T : never;
	cwd: string;
	runtime: ModelRuntime;
}

/**
// Create a fresh, isolated Pi session in a temp directory.
// Global extensions (pi-deep-research, pi-gpt) are available.
 */
export async function createCandidateSession(modelRef?: string): Promise<SessionHandle> {
	const cwd = await mkdtemp(join(tmpdir(), "dr-judge-"));
	const runtime = await ModelRuntime.create();
	const available = await runtime.getAvailable();

	const model = modelRef
		? available.find((m) => `${m.provider}/${m.id}` === modelRef) ?? available[0]
		: available[0];

	if (!model) throw new Error("No models available in runtime");

	const { session } = await createAgentSession({
		cwd,
		modelRuntime: runtime,
		sessionManager: SessionManager.inMemory(cwd),
		model,
	});

	return { session, cwd, runtime };
}

/**
// Health check — verify the environment before a long run (§2.3).
// Returns ok=false with issues[] if anything is missing.
 */
export async function healthCheck(
	checkDrhQuota?: () => Promise<number | null>,
): Promise<HealthStatus> {
	const issues: string[] = [];

	// 1. Extensions loaded
	const cwd = await mkdtemp(join(tmpdir(), "dr-health-"));
	const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
	await loader.reload();
	const extResult = loader.getExtensions();
	const extensions = extResult.extensions ?? [];
	const extPaths = extensions.map((e) => e.path ?? "").filter(Boolean);

	const hasDeepResearch = extPaths.some((p) => p.includes("deep-research") || p.includes("research.ts"));
	const hasGpt = extPaths.some((p) => p.includes("pi-gpt") || p.includes("chatgpt"));

	if (!hasDeepResearch) issues.push("pi-deep-research extension not loaded");
	if (!hasGpt) issues.push("pi-gpt extension not loaded (needed for juror/DRH)");

	// 2. Models available
	const runtime = await ModelRuntime.create();
	const available = await runtime.getAvailable();
	if (available.length === 0) issues.push("No models available in runtime");

	// 3. API keys
	const config = await getConfig();
	const hasExa = !!process.env.EXA_API_KEY || !!config.exaApiKey;
	const hasSgai = !!process.env.SGAI_API_KEY || !!process.env.SCRAPEGRAPH_API_KEY || !!config.scrapegraphApiKey;

	if (!hasExa) issues.push("EXA_API_KEY not set (search backend may fall back to DDG)");
	if (!hasSgai) issues.push("SCRAPEGRAPH_API_KEY not set (scrape backend may fall back to native fetch");

	// 4. DRH quota (optional, only for reference runs)
	let drhQuota: number | null = null;
	if (checkDrhQuota) {
		drhQuota = await checkDrhQuota();
		if (drhQuota !== null && drhQuota <= 0) issues.push("DRH quota exhausted");
	}

	return {
		extensions: extPaths,
		models: available.length,
		apiKeys: { exa: hasExa, scrapegraph: hasSgai },
		drhQuota,
		ok: issues.length === 0,
		issues,
	};
}

/**
// Subscribe to session events and collect them for later inspection.
 */
export function collectEvents(session: { subscribe: (fn: (e: AgentSessionEvent) => void) => () => void }) {
	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((e) => {
		events.push(e);
		if (e.type === "tool_execution_start") {
			console.log(`  ▸ TOOL: ${e.toolName}`);
		}
	});
	return { events, unsubscribe };
}
