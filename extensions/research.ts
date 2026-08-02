// pi-deep-research — a deep-research harness built from Pi primitives.
//
// Tool: dr_research (spec → decompose → search → ingest → extract → claim graph
// → contradiction → confidence → synthesize → audit). Long-running, interruptible,
// resumable. Commands: /research (menu/list/inspect/configure backends).
//
// All external content is trust-tagged (injection heuristics + secret redaction)
// before the model sees it. State persists under .pi/research/<runId>/.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { runResearch } from "../src/orchestrator.ts";
import { RunStore, PROFILES, type ResearchConfig } from "../src/store.ts";
import { getConfig, saveConfig, backendStatus, scrapegraphKey, hasSearchKey, resolveEnabledSearchBackends, resolveEnabledScrapeBackends, type DrConfig, type SearchBackendId, type ScrapeBackendId } from "../src/config.ts";
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
					const resolved = await reg.getProviderAuth(providerId);
					if (resolved) return { ...resolved.auth, env: resolved.env };
				} catch {}
				// Fallback: read OAuth/API key from ~/.pi/agent/auth.json
				// Needed for openai-codex (OAuth) when getProviderAuth returns null
				try {
					const { readFileSync } = await import("node:fs");
					const { join } = await import("node:path");
					const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
					const all = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
					const pa = all[providerId];
					if (pa?.type === "oauth" && pa.access) return { apiKey: pa.access };
					if (pa?.apiKey) return { apiKey: pa.apiKey };
				} catch {}
				return null;
			},
		};
	}

	// ── dr_research ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "dr_research",
		label: "Deep Research",
		description:
			"Run a deep-research investigation with claim graph, contradiction detection, confidence estimation, citation audits, and prompt-injection defense. Returns a cited markdown report plus audit results. Long-running; interruptible (Esc), resumable. Configure backends via /research menu.",
		promptSnippet: "Run a deep-research investigation on a topic",
		parameters: Type.Object({
			topic: Type.String({ description: "The research question to investigate in depth." }),
			profile: Type.Optional(
				Type.Union([Type.Literal("quick"), Type.Literal("benchmark"), Type.Literal("standard"), Type.Literal("deep"), Type.Literal("heavy"), Type.Literal("ultra")], {
					description: "Depth preset: quick (~10 sources), benchmark (~15 sources), standard (default), deep (~40 sources), heavy (~60 sources), ultra (~100 sources — maximal length and audit rigor). Explicit params below override the preset.",
				}),
			),
			breadth: Type.Optional(Type.Integer({ description: "Sources per search round (default 5)." })),
			depth: Type.Optional(Type.Integer({ description: "Max follow-up depth for gap subquestions (default 2)." })),
			max_sources: Type.Optional(Type.Integer({ description: "Hard cap on ingested sources (default 25)." })),
			max_iterations: Type.Optional(Type.Integer({ description: "Hard cap on loop iterations (default 12)." })),
			citation_checks: Type.Optional(Type.Integer({ description: "How many cited sentences get an LLM entailment check (default 25; raise for long reports)." })),
			resume: Type.Optional(Type.Boolean({ description: "Resume an interrupted run (uses run_id or latest)." })),
			run_id: Type.Optional(Type.String({ description: "Run id to resume." })),
		}),
		async execute(_id, p, signal, onUpdate, ctx) {
			const config: Partial<ResearchConfig> = { ...(PROFILES[p.profile ?? "standard"] ?? {}) };
			if (p.breadth != null) config.breadth = p.breadth;
			if (p.depth != null) config.depth = p.depth;
			if (p.max_sources != null) config.max_sources = p.max_sources;
			if (p.max_iterations != null) config.max_iterations = p.max_iterations;
			if (p.citation_checks != null) config.citation_checks = p.citation_checks;

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




	// ── /research — navigable menu, list, or inspect ───────────────────
	pi.registerCommand("research", {
		description: "Configure backends, list runs, or inspect one. No args = menu.",
		handler: async (args, ctx) => {
			const target = args.trim();

			// /research <runId> → inspect
			if (target) {
				const store = new RunStore(ctx.cwd, target);
				const meta = await store.loadMeta();
				if (!meta) { ctx.ui.notify(`No run '${target}' found.`, "warning"); return; }
				const claims = await store.loadClaims();
				const edges = await store.loadEdges();
				ctx.ui.notify(
					`${meta.id}\ntopic: ${meta.topic}\nstatus: ${meta.status}\nsources: ${meta.stats.sources_ingested} · evidence: ${meta.stats.evidence_extracted} · claims: ${claims.length} · edges: ${edges.length}\nreport: ${store.reportFile()}`,
					"info",
				);
				return;
			}

			// /research (no args) → main menu loop
			let inMenu = true;
			while (inMenu) {
				const cfg = await getConfig();
				const searchBackends = resolveEnabledSearchBackends(cfg);
				const scrapeBackends = resolveEnabledScrapeBackends(cfg);

				// Build status line
				const searchLabels: Record<string, string> = { exa: "Exa", ddg: "DDG", tavily: "Tavily", scrapegraph: "ScrapeGraph" };
				const scrapeLabels: Record<string, string> = { native: "Native", scrapegraph: "ScrapeGraph" };
				const searchStatus = (["exa","ddg","tavily","scrapegraph"] as const).map((id: string) => {
					const enabled = searchBackends.includes(id as SearchBackendId);
					const hasKey = id === "ddg" || hasSearchKey(cfg, id as SearchBackendId);
					return `${searchLabels[id]} ${enabled ? "✓" : "✗"}${!hasKey && id !== "ddg" ? " (no key)" : ""}`;
				}).join("  ");
				const scrapeStatus = (["native","scrapegraph"] as const).map(id => {
					const enabled = scrapeBackends.includes(id);
					return `${scrapeLabels[id]} ${enabled ? "✓" : "✗"}`;
				}).join("  ");

				const mainChoice = await ctx.ui.select(
					`Deep Research — search:[${searchStatus}]  scrape:[${scrapeStatus}]`,
					["Search backends…", "Scrape backends…", "API keys…", "List runs", "Done"]
				);
				if (!mainChoice || mainChoice === "Done") { inMenu = false; continue; }

				if (mainChoice === "Search backends…") {
					// Submenu: toggle each search backend
					let inSearch = true;
					while (inSearch) {
						const c = await getConfig();
						const enabled = resolveEnabledSearchBackends(c);
						const opts = (["exa","ddg","tavily","scrapegraph"] as const).map(id => {
							const on = enabled.includes(id);
							const key = id === "ddg" ? "free" : hasSearchKey(c, id) ? "key ✓" : "no key";
							return `${on ? "✓" : "✗"} ${searchLabels[id]} (${key})`;
						});
						opts.push("Back");
						const sel = await ctx.ui.select("Search backends (toggle)", opts);
						if (!sel || sel === "Back") { inSearch = false; continue; }
						// Find which backend was selected
						const idx = opts.indexOf(sel!);
						const allIds: SearchBackendId[] = ["exa","ddg","tavily","scrapegraph"];
						if (idx >= 0 && idx < 4) {
							const id = allIds[idx];
							const currentlyEnabled = resolveEnabledSearchBackends(await getConfig());
							const hasKey = (id as string) === "ddg" || hasSearchKey(await getConfig(), id);
							// If trying to enable but no key → prompt for key
							if (!currentlyEnabled.includes(id) && !hasKey) {
								if ((id as string) !== "ddg") {
									const newKey = await ctx.ui.input(`Enter ${searchLabels[id]} API key`, "");
									if (newKey) {
										const keyField = id === "exa" ? "exaApiKey" : id === "tavily" ? "tavilyApiKey" : "scrapegraphApiKey";
										await saveConfig({ [keyField]: newKey } as DrConfig);
									} else { continue; } // cancelled, don't enable
								}
							}
							// Toggle
							const newEnabled = currentlyEnabled.includes(id)
								? currentlyEnabled.filter(x => x !== id)
								: [...currentlyEnabled, id];
							// Never allow empty — always keep at least DDG
							if (newEnabled.length === 0) { ctx.ui.notify("At least one search backend required.", "warning"); continue; }
							await saveConfig({ enabledSearchBackends: newEnabled });
						}
					}
				}

				if (mainChoice === "Scrape backends…") {
					let inScrape = true;
					while (inScrape) {
						const c = await getConfig();
						const enabled = resolveEnabledScrapeBackends(c);
						const opts = (["native","scrapegraph"] as const).map(id => {
							const on = enabled.includes(id);
							const key = id === "native" ? "free" : scrapegraphKey(c) ? "key ✓" : "no key";
							return `${on ? "✓" : "✗"} ${scrapeLabels[id]} (${key})`;
						});
						opts.push("Back");
						const sel = await ctx.ui.select("Scrape backends (toggle)", opts);
						if (!sel || sel === "Back") { inScrape = false; continue; }
						const idx = opts.indexOf(sel!);
						const allIds: ScrapeBackendId[] = ["native","scrapegraph"];
						if (idx >= 0 && idx < 2) {
							const id = allIds[idx];
							const currentlyEnabled = resolveEnabledScrapeBackends(await getConfig());
							if (!currentlyEnabled.includes(id) && id === "scrapegraph" && !scrapegraphKey(await getConfig())) {
								const newKey = await ctx.ui.input("Enter ScrapeGraph API key", "");
								if (newKey) { await saveConfig({ scrapegraphApiKey: newKey } as DrConfig); }
								else { continue; }
							}
							const newEnabled = currentlyEnabled.includes(id)
								? currentlyEnabled.filter(x => x !== id)
								: [...currentlyEnabled, id];
							if (newEnabled.length === 0) { ctx.ui.notify("At least one scrape backend required.", "warning"); continue; }
							await saveConfig({ enabledScrapeBackends: newEnabled });
						}
					}
				}

				if (mainChoice === "API keys…") {
					let inKeys = true;
					while (inKeys) {
						const c = await getConfig();
						const opts = [
							`Exa: ${c.exaApiKey ? c.exaApiKey.slice(0, 8) + "…" : "(not set)"}`,
							`ScrapeGraph: ${c.scrapegraphApiKey ? c.scrapegraphApiKey.slice(0, 8) + "…" : "(not set)"}`,
							`Tavily: ${c.tavilyApiKey ? c.tavilyApiKey.slice(0, 8) + "…" : "(not set)"}`,
							"Back",
						];
						const sel = await ctx.ui.select("API keys", opts);
						if (!sel || sel === "Back") { inKeys = false; continue; }
						if (sel.startsWith("Exa")) {
							const val = await ctx.ui.input("Exa API key", "Enter key or empty to clear");
							await saveConfig({ exaApiKey: val || "" } as DrConfig);
						} else if (sel.startsWith("ScrapeGraph")) {
							const val = await ctx.ui.input("ScrapeGraph API key", "Enter key or empty to clear");
							await saveConfig({ scrapegraphApiKey: val || "" } as DrConfig);
						} else if (sel.startsWith("Tavily")) {
							const val = await ctx.ui.input("Tavily API key", "Enter key or empty to clear");
							await saveConfig({ tavilyApiKey: val || "" } as DrConfig);
						}
					}
				}

				if (mainChoice === "List runs") {
					const runs = await RunStore.list(ctx.cwd);
					if (runs.length === 0) { ctx.ui.notify("No research runs in this project yet.", "info"); continue; }
					const metas = await Promise.all(runs.map(async (id) => new RunStore(ctx.cwd, id).loadMeta()));
					const lines = metas.filter((m): m is NonNullable<typeof m> => !!m).map(
						(m) => `${m.status === "completed" ? "✓" : m.status === "interrupted" ? "⏸" : "●"} ${m.id}  —  ${m.topic}  (${m.stats.sources_ingested} src / ${m.stats.evidence_extracted} ev)`,
					);
					ctx.ui.notify(`Research runs:\n${lines.join("\n")}`, "info");
				}
			}
		},
	});
}
