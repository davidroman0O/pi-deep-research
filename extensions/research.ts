// pi-deep-research — a deep-research harness built from Pi primitives.
//
// Tool: dr_research (spec → decompose → search → ingest → extract → claim graph
// → contradiction → confidence → synthesize → audit). Long-running, interruptible,
// resumable. Commands: /research (list/inspect runs), /research-config (backends).
//
// All external content is trust-tagged (injection heuristics + secret redaction)
// before the model sees it. State persists under .pi/research/<runId>/.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { runResearch } from "../src/orchestrator.ts";
import { RunStore, PROFILES, type ResearchConfig } from "../src/store.ts";
import { getConfig, saveConfig, backendStatus, type DrConfig } from "../src/config.ts";
import type { ModelHandle } from "../src/llm.ts";

export default function (pi: ExtensionAPI) {
	const WIDGET_KEY = "pi-deep-research";

	function handle(ctx: any): ModelHandle {
		const reg = ctx.modelRegistry;
		const model = ctx.model;
		if (!reg || !model) throw new Error("No active model — select a model in Pi first.");
		return {
			model,
			getAuth: async (providerId: string) => {
				try {
					return (await reg.getProviderAuth(providerId)) ?? null;
				} catch {
					return null;
				}
			},
		};
	}

	// ── dr_research ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "dr_research",
		label: "Deep Research",
		description:
			"Run a deep-research investigation with claim graph, contradiction detection, confidence estimation, citation audits, and prompt-injection defense. Returns a cited markdown report plus audit results. Long-running; interruptible (Esc), resumable. Backends configurable via /research-config (search: ddg/tavily/exa/scrapegraph, scrape: native/scrapegraph).",
		promptSnippet: "Run a deep-research investigation on a topic",
		parameters: Type.Object({
			topic: Type.String({ description: "The research question to investigate in depth." }),
			profile: Type.Optional(
				Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep"), Type.Literal("heavy")], {
					description: "Depth preset: quick (~10 sources), standard (default), deep (~40 sources), heavy (~60 sources, longest, most detailed report). Explicit params below override the preset.",
				}),
			),
			breadth: Type.Optional(Type.Integer({ description: "Sources per search round (default 5)." })),
			depth: Type.Optional(Type.Integer({ description: "Max follow-up depth for gap subquestions (default 2)." })),
			max_sources: Type.Optional(Type.Integer({ description: "Hard cap on ingested sources (default 25)." })),
			max_iterations: Type.Optional(Type.Integer({ description: "Hard cap on loop iterations (default 12)." })),
			resume: Type.Optional(Type.Boolean({ description: "Resume an interrupted run (uses run_id or latest)." })),
			run_id: Type.Optional(Type.String({ description: "Run id to resume." })),
		}),
		async execute(_id, p, signal, onUpdate, ctx) {
			const config: Partial<ResearchConfig> = { ...(PROFILES[p.profile ?? "standard"] ?? {}) };
			if (p.breadth != null) config.breadth = p.breadth;
			if (p.depth != null) config.depth = p.depth;
			if (p.max_sources != null) config.max_sources = p.max_sources;
			if (p.max_iterations != null) config.max_iterations = p.max_iterations;

			let resumeId: string | undefined = p.run_id;
			if (p.resume && !resumeId) {
				const all = await RunStore.list(ctx.cwd);
				if (all.length === 0) {
					return {
						content: [{ type: "text", text: "No previous runs to resume. Start a fresh run by omitting `resume`." }],
						details: { no_runs: true },
						isError: true,
					};
				}
				resumeId = all[0];
			}

			const backends = await backendStatus();
			ctx.ui.setWidget(WIDGET_KEY, [
				`${resumeId ? "↻ Resuming" : "🔬 Researching"}: ${p.topic}`,
				`backends — ${backends}`,
			]);

			try {
				const result = await runResearch(
					p.topic,
					{
						cwd: ctx.cwd,
						handle: handle(ctx),
						signal,
						config,
						onProgress: (line, stats) => {
							ctx.ui.setStatus(WIDGET_KEY, line);
							ctx.ui.setWidget(
								WIDGET_KEY,
								[
									`🔬 ${resumeId ? "↻ " : ""}${p.topic}`,
									line,
									stats
										? `searches ${stats.searches} · sources ${stats.sources_ingested} · evidence ${stats.evidence_extracted} · iter ${stats.iterations}`
										: "",
								].filter(Boolean),
							);
							onUpdate?.({
								content: [{ type: "text", text: line }],
								details: { progress: line, stats },
							});
						},
					},
					resumeId,
				);

				ctx.ui.setStatus(WIDGET_KEY, "research complete");
				ctx.ui.setWidget(WIDGET_KEY, [
					`✓ ${result.runId}`,
					`${result.sources.length} sources · ${result.evidence.length} evidence · ${result.claims.length} claims · ${result.edges.length} edges`,
					`audit: ${result.audit.overall_pass ? "PASS" : "warnings — see report"}`,
				]);

				return {
					content: [
						{
							type: "text",
							text:
								`# Deep Research: ${p.topic}\n\n` +
								`**Run:** ${result.runId}\n` +
								`**Sources:** ${result.sources.length} · **Evidence:** ${result.evidence.length} · **Claims:** ${result.claims.length} · **Relations:** ${result.edges.length}\n` +
								`**Audit:** ${result.audit.overall_pass ? "✅ pass" : "⚠️ warnings"}\n\n` +
								`Report: \`${result.reportFile}\`\n\n---\n\n${result.report}`,
						},
					],
					details: {
						run_id: result.runId,
						report_file: result.reportFile,
						sources: result.sources.length,
						evidence: result.evidence.length,
						claims: result.claims.length,
						edges: result.edges.length,
						audit: result.audit,
						spec: result.meta.spec,
						run_dir: join(ctx.cwd, ".pi", "research", result.runId),
					},
				};
			} catch (err) {
				const aborted = (err as Error & { aborted?: boolean })?.aborted;
				if (aborted) {
					return {
						content: [
							{
								type: "text",
								text: `Research interrupted. State saved — resume with dr_research {resume:true}. Runs: ${(await RunStore.list(ctx.cwd)).join(", ") || "(none)"}`,
							},
						],
						details: { interrupted: true },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Research failed: ${(err as Error).message}` }],
					details: { error: String((err as Error).message) },
					isError: true,
				};
			}
		},
	});

	// ── /research — list or inspect runs ─────────────────────────────────
	pi.registerCommand("research", {
		description: "List deep-research runs or inspect one: /research [runId]",
		handler: async (args, ctx) => {
			const runs = await RunStore.list(ctx.cwd);
			const target = args.trim();
			if (!target) {
				if (runs.length === 0) {
					ctx.ui.notify("No research runs in this project yet.", "info");
					return;
				}
				const metas = await Promise.all(runs.map(async (id) => new RunStore(ctx.cwd, id).loadMeta()));
				const lines = metas
					.filter((m): m is NonNullable<typeof m> => !!m)
					.map(
						(m) =>
							`${m.status === "completed" ? "✓" : m.status === "interrupted" ? "⏸" : "●"} ${m.id}  —  ${m.topic}  (${m.stats.sources_ingested} src / ${m.stats.evidence_extracted} ev)`,
					);
				ctx.ui.notify(`Research runs:\n${lines.join("\n")}`, "info");
				return;
			}
			const store = new RunStore(ctx.cwd, target);
			const meta = await store.loadMeta();
			if (!meta) {
				ctx.ui.notify(`No run '${target}' found.`, "warning");
				return;
			}
			const claims = await store.loadClaims();
			const edges = await store.loadEdges();
			ctx.ui.notify(
				`${meta.id}\ntopic: ${meta.topic}\nstatus: ${meta.status}\nsources: ${meta.stats.sources_ingested} · evidence: ${meta.stats.evidence_extracted} · claims: ${claims.length} · edges: ${edges.length}\nreport: ${store.reportFile()}`,
				"info",
			);
		},
	});

	// ── /research-config — backend selection ─────────────────────────────
	pi.registerCommand("research-config", {
		description:
			"Configure deep-research backends. Usage: /research-config [search ddg|tavily|exa|scrapegraph] [scrape native|scrapegraph] [paid on|off] [key exa|tavily|scrapegraph <key>]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				const cfg = await getConfig();
				ctx.ui.notify(`Current config:\n${JSON.stringify(cfg, null, 2)}\n\nEffective: ${await backendStatus()}`, "info");
				return;
			}
			const updates: DrConfig = {};
			for (let i = 0; i < parts.length; i++) {
				const [field, value] = [parts[i], parts[i + 1]];
				if (field === "search" && ["ddg", "tavily", "exa", "scrapegraph"].includes(value)) {
					updates.search = value as DrConfig["search"];
					i++;
				} else if (field === "scrape" && ["native", "scrapegraph"].includes(value)) {
					updates.scrape = value as DrConfig["scrape"];
					i++;
				} else if (field === "paid") {
					updates.allowPaidBackends = value !== "off";
					i++;
				} else if (field === "key" && ["exa", "tavily", "scrapegraph"].includes(value) && parts[i + 2]) {
					if (value === "exa") updates.exaApiKey = parts[i + 2];
					if (value === "tavily") updates.tavilyApiKey = parts[i + 2];
					if (value === "scrapegraph") updates.scrapegraphApiKey = parts[i + 2];
					i += 2;
				}
			}
			const next = await saveConfig(updates);
			const masked = { ...next };
			for (const k of ["exaApiKey", "tavilyApiKey", "scrapegraphApiKey"] as const) {
				if (masked[k]) masked[k] = masked[k]!.slice(0, 8) + "…";
			}
			ctx.ui.notify(`Saved. Config:\n${JSON.stringify(masked, null, 2)}\n\nEffective: ${await backendStatus()}`, "info");
		},
	});
}
