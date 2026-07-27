// src/orchestrator.ts — the deep-research pipeline.
//
// Implements the reference design's dynamic research loop (§14) on a real task
// graph (§4): tasks carry dependencies, the loop schedules the READY SET in
// parallel, and each source flows through its own extractor + summarizer
// invocation (§26's specialist roles as parallel model calls, bounded).
//
//   spec → decompose →
//     loop: ready tasks ─parallel→
//       queries → parallel search → rank/dedup →
//         per source ─parallel→ ingest(trust) → novelty → passage-select →
//         extract → source memo ─then→ task memo →
//     gap check → dynamic tasks (depends_on) → stopping criteria
//   claim graph + parallel relation edges → topic syntheses →
//   synthesis → citation entailment + static audits
//
// Store writes happen on the main thread after each parallel batch —
// single-writer, no races. Everything is resumable via disk state.

import { llmJson, llmText, type ModelHandle } from "./llm.ts";
import {
	RunStore,
	makeRunId,
	DEFAULT_CONFIG,
	type RunMeta,
	type Spec,
	type Task,
	type Source,
	type Evidence,
	type Claim,
	type ClaimEdge,
	type TaskMemo,
	type SourceMemo,
	type ResearchConfig,
} from "./store.ts";
import { getSearchProvider, rankResults, type SearchProvider, type SearchResult } from "./search.ts";
import { ingestUrl, type Document } from "./ingest.ts";
import { wrapUntrusted } from "./trust.ts";
import { canonicalUrl, contentHash, simhash, checkDuplicate, novelty } from "./novel.ts";
import { clusterClaims, buildClaim, relationInput, toEdge, type ClaimRelation } from "./claimgraph.ts";
import { assessSourceQuality, compositeQuality, qualityLabel } from "./quality.ts";
import { chunkDocument, selectPassages, assembleContext } from "./passage.ts";
import { runParallel, successes } from "./parallel.ts";
import { auditCitations, runStaticAudits, assembleAudit, type AuditReport } from "./audits.ts";
import {
	SPEC_SYSTEM, specPrompt, SPEC_TOOL,
	DECOMPOSE_SYSTEM, decomposePrompt, DECOMPOSE_TOOL,
	QUERY_SYSTEM, queryPrompt, QUERY_TOOL,
	EXTRACT_SYSTEM, extractPrompt, EXTRACT_TOOL,
	SOURCE_MEMO_SYSTEM, sourceMemoPrompt, SOURCE_MEMO_TOOL,
	TASK_MEMO_SYSTEM, taskMemoPrompt, TASK_MEMO_TOOL,
	GAP_SYSTEM, gapPrompt, GAP_TOOL,
	RELATION_SYSTEM, relationPrompt, RELATION_TOOL,
	TOPIC_SYNTH_SYSTEM, topicSynthPrompt, TOPIC_SYNTH_TOOL,
	NUMERIC_SYSTEM, numericPrompt, NUMERIC_TOOL,
	OUTLINE_SYSTEM, outlinePrompt, OUTLINE_TOOL,
	SECTION_SYSTEM, sectionPrompt,
	EXEC_SUMMARY_SYSTEM, execSummaryPrompt,
	CITATION_REPAIR_SYSTEM, citationRepairPrompt, CITATION_REPAIR_TOOL,
} from "./prompts.ts";

export interface OrchestratorDeps {
	cwd: string;
	handle: ModelHandle;
	signal?: AbortSignal;
	config?: Partial<ResearchConfig>;
	searchProvider?: SearchProvider;
	onProgress?: (line: string, stats?: RunMeta["stats"]) => void;
}

export interface ResearchResult {
	runId: string;
	report: string;
	meta: RunMeta;
	sources: Source[];
	evidence: Evidence[];
	claims: Claim[];
	edges: ClaimEdge[];
	audit: AuditReport;
	reportFile: string;
}

interface ExtractToolArgs {
	evidence: Array<{
		claim: string;
		values?: Record<string, string | number>;
		conditions?: string;
		confidence: number;
		quote?: string;
	}>;
	injection_detected?: string[];
}

interface SourceOutcome {
	result: SearchResult;
	doc?: Document;
	source?: Source;
	evidence: Evidence[];
	memo?: SourceMemo;
	rawText?: string;
	injection?: string[];
	skipReason?: string;
}

const NOVELTY_FLOOR = 0.15;
const MAX_RELATION_CHECKS = 15;
const MAX_TOTAL_TASKS = 14;
const TASK_CONCURRENCY = 2; // tasks researched in parallel (§26 bounded fan-out)
const SOURCE_CONCURRENCY = 3; // sources ingested/extracted in parallel per task
const EXTRACT_CHAR_BUDGET = 14_000; // §13.2 budgeted context assembly

export async function runResearch(
	topic: string,
	deps: OrchestratorDeps,
	resumeRunId?: string,
): Promise<ResearchResult> {
	const config = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
	const runId = resumeRunId ?? makeRunId(topic);
	const store = new RunStore(deps.cwd, runId);
	await store.init();
	const search = deps.searchProvider ?? (await getSearchProvider());

	let meta = await store.loadMeta();
	if (meta && resumeRunId) {
		meta.status = "running";
	} else {
		meta = {
			id: runId,
			topic,
			created_at: new Date().toISOString(),
			status: "running",
			config,
			stats: { searches: 0, sources_ingested: 0, evidence_extracted: 0, iterations: 0 },
		};
	}
	await store.saveMeta(meta);

	const progress = (line: string) => deps.onProgress?.(line, meta!.stats);
	const checkAbort = () => {
		if (deps.signal?.aborted) {
			const err = new Error("aborted") as Error & { aborted?: true };
			err.aborted = true;
			throw err;
		}
	};

	const injectionFlags: string[] = [];
	const topicKeywords = topic.split(/\s+/).filter((w) => w.length > 3).slice(0, 8);

	try {
		// ── Phase 1: specification ─────────────────────────────────────────
		if (!meta.spec) {
			progress("Specifying research objective…");
			const raw = await llmJson<Omit<Spec, "source_policy" | "freshness">>(
				deps.handle, SPEC_TOOL, SPEC_SYSTEM, specPrompt(topic),
				{ signal: deps.signal, temperature: 0.3 },
			);
			meta.spec = {
				...raw,
				source_policy: { prefer_primary: true, minimum_independent_support: 2 },
				freshness: { current_as_of: new Date().toISOString().slice(0, 10) },
			};
			await store.saveMeta(meta);
		}

		// ── Phase 2: decomposition into a task graph (§4) ──────────────────
		let tasks = await store.loadTasks();
		if (tasks.length === 0) {
			progress("Decomposing into a task graph…");
			const { tasks: raw } = await llmJson<{ tasks: Array<Omit<Task, "id" | "status" | "depth">> }>(
				deps.handle, DECOMPOSE_TOOL, DECOMPOSE_SYSTEM, decomposePrompt(meta.spec),
				{ signal: deps.signal, temperature: 0.4 },
			);
			tasks = raw.map((t, i) => ({
				id: `t${i + 1}`,
				question: t.question,
				priority: t.priority,
				completion_test: t.completion_test,
				depth: 0,
				status: "open" as const,
				depends_on: [],
			}));
			await store.saveTasks(tasks);
		}

		// ── Phases 3-5: dynamic loop over the ready set ────────────────────
		let sources = await store.loadSources();
		const sourceMemos: SourceMemo[] = await store.loadSourceMemos();
		const taskMemos: TaskMemo[] = await store.loadTaskMemos();
		let consecutiveLowNovelty = 0;

		while (meta.stats.iterations < config.max_iterations && sources.length < config.max_sources) {
			checkAbort();
			const ready = readyTasks(tasks);
			if (ready.length === 0) break;
			const batch = ready.slice(0, TASK_CONCURRENCY);
			for (const t of batch) t.status = "in_progress";
			await store.saveTasks(tasks);

			progress(`[iter ${meta.stats.iterations + 1}] researching ${batch.length} task(s) in parallel…`);

			// ── parallel task pipelines ────────────────────────────────────
			const taskOutcomes = await runParallel(
				batch,
				async (task) => {
					// query generation
					const evidenceSoFar = await store.loadEvidence();
					const knownSoFar = evidenceSoFar
						.filter((e) => e.task_id === task.id)
						.map((e) => `- ${e.claim}`)
						.join("\n");
					const { queries } = await llmJson<{ queries: string[] }>(
						deps.handle, QUERY_TOOL, QUERY_SYSTEM, queryPrompt(task, knownSoFar),
						{ signal: deps.signal, temperature: 0.6 },
					);

					// parallel search across the task's queries
					const toRun = queries.slice(0, config.max_search_queries);
					const searchOutcomes = await runParallel(
						toRun,
						async (q) => {
							try {
								return await search.search(q, deps.signal, config.breadth);
							} catch (err) {
								return { error: String(err), query: q };
							}
						},
						config.max_search_queries,
						deps.signal,
					);
					const allResults: SearchResult[] = [];
					for (const o of searchOutcomes) {
						if (!o.ok) continue;
						if (Array.isArray(o.value)) allResults.push(...o.value);
						else await store.log("search_error", o.value);
					}
					const ranked = rankResults(allResults).slice(0, config.breadth);

					// parallel source pipelines: ingest → novelty → extract → source memo
					const sourceOutcomes = await runParallel(
						ranked,
						(res): Promise<SourceOutcome> => sourcePipeline(res, task, sources, evidenceSoFar, deps, topicKeywords),
						SOURCE_CONCURRENCY,
						deps.signal,
					);

					return { task, queries: toRun, outcomes: sourceOutcomes };
				},
				TASK_CONCURRENCY,
				deps.signal,
			);

			// ── central apply: single-writer to the store ──────────────────
			for (const outcome of taskOutcomes) {
				if (!outcome.ok) {
					await store.log("task_error", { error: String(outcome.error) });
					continue;
				}
				const { task, queries, outcomes } = outcome.value;
				meta.stats.searches += queries.length;

				const newEvidence: Evidence[] = [];
				const newMemos: SourceMemo[] = [];
				let taskNovelHits = 0;

				for (const so of outcomes) {
					if (!so.ok) {
						await store.log("source_error", { error: String(so.error) });
						continue;
					}
					const s = so.value;
					if (s.skipReason) {
						await store.log("source_skipped", { url: s.result.url, reason: s.skipReason });
						if (s.skipReason === "low-novelty") taskNovelHits++;
						continue;
					}
					if (!s.source || !s.doc) continue;

					// RENUMBER centrally: parallel tasks all numbered from the same
					// base, so worker-assigned ids collide. Final id assigned here,
					// then remapped through evidence + memo.
					const finalId = `s${sources.length + 1}`;
					const workerId = s.source.id;
					s.source.id = finalId;
					for (const ev of s.evidence) ev.source_id = finalId;
					if (s.memo) s.memo.source_id = finalId;

					// archive raw (tier 0) + register source
					if (s.rawText) await store.saveRawSource(finalId, s.rawText);
					sources.push(s.source);
					if (s.injection?.length) injectionFlags.push(...s.injection.map(() => s.result.url));
					newEvidence.push(...s.evidence);
					if (s.memo) newMemos.push(s.memo);
				}

				meta.stats.sources_ingested = sources.length;
				for (const ev of newEvidence) {
					ev.id = `e${meta.stats.evidence_extracted + 1}`;
					meta.stats.evidence_extracted++;
					await store.appendEvidence(ev);
				}
				for (const m of newMemos) sourceMemos.push(m);
				await store.saveSources(sources);
				await store.saveSourceMemos(sourceMemos);
				await store.saveMeta(meta);

				// task memo (LLM summarization, tier 3) — synthesized from every
				// source memo this task's evidence touches, across all iterations
				const allTaskEvidence = (await store.loadEvidence()).filter((e) => e.task_id === task.id);
				const taskSourceIds = new Set(allTaskEvidence.map((e) => e.source_id));
				const taskSourceMemos = sourceMemos.filter((m) => taskSourceIds.has(m.source_id));
				const memoDigest = taskSourceMemos
					.map((m) => `- [${m.source_id}] ${m.purpose}: ${m.key_findings.join("; ")} (limits: ${m.limitations.join("; ") || "none"})`)
					.join("\n");
				const memo = await llmJson<{ key_findings: string[]; limitations: string[]; open_issues: string[] }>(
					deps.handle, TASK_MEMO_TOOL, TASK_MEMO_SYSTEM,
					taskMemoPrompt(task, memoDigest || allTaskEvidence.map((e) => `- ${e.claim}`).join("\n") || "(no evidence found)"),
					{ signal: deps.signal, temperature: 0.3 },
				);
				taskMemos.push({
					task_id: task.id,
					key_findings: memo.key_findings,
					limitations: [...memo.limitations, ...memo.open_issues.map((i) => `open: ${i}`)],
					relevant_claims: allTaskEvidence.map((e) => e.id),
					created_at: new Date().toISOString(),
				});
				await store.saveTaskMemos(taskMemos);

				task.status = "done";
				task.summary = memo.key_findings[0];
				await store.saveTasks(tasks);
				progress(`✓ ${task.id} done — ${newEvidence.length} evidence, ${newMemos.length} source memos`);

				if (taskNovelHits >= 2) consecutiveLowNovelty++;
				else consecutiveLowNovelty = 0;
			}

			// gap detection + dynamic task discovery (§16)
			meta.stats.iterations++;
			await store.saveMeta(meta);
			progress(`Iteration ${meta.stats.iterations}: gap check…`);

			const digest = taskMemos
				.map((m) => `- [${m.task_id}] ${m.key_findings.slice(0, 3).join("; ")}`)
				.join("\n");
			const gap = await llmJson<{ gaps: string[]; new_subquestions: string[]; should_continue: boolean }>(
				deps.handle, GAP_TOOL, GAP_SYSTEM,
				gapPrompt(meta.spec, tasks, digest, "(computed after claim graph)"),
				{ signal: deps.signal, temperature: 0.3 },
			);
			await store.log("gap_check", gap);

			// dynamic tasks depend on everything completed so far (§4.1 task graph)
			const doneIds = tasks.filter((t) => t.status === "done").map((t) => t.id);
			for (const sq of gap.new_subquestions.slice(0, 3)) {
				if (tasks.length >= MAX_TOTAL_TASKS) break;
				if (config.max_iterations - meta.stats.iterations < 2) break;
				if (tasks.some((t) => t.question === sq)) continue;
				tasks.push({
					id: `t${tasks.length + 1}`,
					question: sq,
					priority: 6,
					depth: 1,
					status: "open",
					depends_on: doneIds.slice(-2), // ties the new task into the graph
				});
			}
			await store.saveTasks(tasks);

			// stopping criteria (§20)
			if (!gap.should_continue) {
				await store.log("stopping", { reason: "gap checker: adequate coverage" });
				break;
			}
			if (consecutiveLowNovelty >= 3) {
				await store.log("stopping", { reason: "novelty saturation" });
				break;
			}
		}

		// ── Phase 6: claim graph + parallel relation edges ─────────────────
		checkAbort();
		progress("Building claim graph…");
		const allEvidence = await store.loadEvidence();
		const clusters = clusterClaims(allEvidence);
		const claims: Claim[] = clusters.map((cluster, i) => buildClaim(`c${i + 1}`, cluster, sources));
		await store.saveClaims(claims);

		const pairs = prioritizePairs(claims).slice(0, MAX_RELATION_CHECKS);
		const edgeOutcomes = await runParallel(
			pairs,
			async ([a, b]) => {
				const rel = await llmJson<{ relation: ClaimRelation | "unrelated"; reason?: string }>(
					deps.handle, RELATION_TOOL, RELATION_SYSTEM, relationPrompt(relationInput(a, b)),
					{ signal: deps.signal, temperature: 0 },
				);
				return rel.relation === "unrelated" ? null : { ...toEdge(a.id, b.id, rel.relation), reason: rel.reason };
			},
			3,
			deps.signal,
		);
		const edges: ClaimEdge[] = successes(edgeOutcomes).filter((e): e is NonNullable<typeof e> => e !== null);
		await store.saveEdges(edges);
		const contradictions = edges.filter((e) => e.relation === "contradicts");
		if (contradictions.length > 0) await store.log("contradictions", { count: contradictions.length, edges: contradictions });

		// ── Phase 6b: topic syntheses (tier 4) ─────────────────────────────
		checkAbort();
		progress("Synthesizing per-dimension conclusions…");
		const claimsByDim = meta.spec.dimensions
			.map((dim) => {
				const dimClaims = claims.filter((c) => c.text.toLowerCase().includes(dim.toLowerCase().split(" ")[0].slice(0, 8)));
				return `### ${dim}\n${dimClaims.map((c) => `- ${c.text} [${c.status}, ${c.confidence.toFixed(2)}]`).join("\n") || "(no claims)"}`;
			})
			.join("\n");
		const { syntheses } = await llmJson<{ syntheses: Array<{ dimension: string; synthesis: string; confidence: string }> }>(
			deps.handle, TOPIC_SYNTH_TOOL, TOPIC_SYNTH_SYSTEM, topicSynthPrompt(meta.spec, claimsByDim),
			{ signal: deps.signal, temperature: 0.3 },
		);

		// ── Phase 6c: quantitative normalization (§18) ───────────────────────
		checkAbort();
		const valueClaims = allEvidence
			.filter((e) => e.values && Object.keys(e.values).length > 0)
			.map((e) => {
				const srcNum = sources.findIndex((s) => s.id === e.source_id) + 1;
				return `- ${e.claim} | values: ${JSON.stringify(e.values)} | conditions: ${e.conditions ?? "none"} | source [${srcNum}]`;
			})
			.join("\n");
		let numericSection = "";
		if (valueClaims.length >= 3) {
			progress("Normalizing quantitative claims…");
			const { rows } = await llmJson<{ rows: Array<{ metric: string; subject: string; value: string; normalized?: string; conditions: string; citation: number; comparable: boolean }> }>(
				deps.handle, NUMERIC_TOOL, NUMERIC_SYSTEM, numericPrompt(meta.spec, valueClaims),
				{ signal: deps.signal, temperature: 0.2 },
			);
			const byMetric = new Map<string, typeof rows>();
			for (const r of rows) {
				if (!byMetric.has(r.metric)) byMetric.set(r.metric, []);
				byMetric.get(r.metric)!.push(r);
			}
			numericSection =
				"\n\n## Quantitative Comparison (normalized)\n\n" +
				[...byMetric.entries()]
					.map(([metric, rs]) => {
						const header = `| Subject | Value | Normalized | Conditions | Source |\n|---|---|---|---|---|`;
						const body = rs
							.map((r) => `| ${r.subject} | ${r.value} | ${r.normalized ?? "—"} | ${r.conditions}${r.comparable ? "" : " ⚠️ not directly comparable"} | [${r.citation}] |`)
							.join("\n");
						return `### ${metric}\n${header}\n${body}`;
					})
					.join("\n\n");
		}
		checkAbort();
		progress("Designing report outline…");
		const claimsDigest = claims
			.map((c, i) => {
				const srcNums = c.source_ids.map((sid) => sources.findIndex((s) => s.id === sid) + 1).filter((n) => n > 0);
				return `C${i + 1} [${c.status}, conf ${c.confidence.toFixed(2)}] ${c.text} | cite as: ${srcNums.map((n) => `[${n}]`).join(" ")} | assumptions: ${c.assumptions.join("; ") || "none"}`;
			})
			.join("\n");
		const synthesesDigest = syntheses.map((s) => `### ${s.dimension} [${s.confidence}]\n${s.synthesis}`).join("\n");

		const { sections } = await llmJson<{ sections: Array<{ title: string; objective: string; claim_ids: string[] }> }>(
			deps.handle, OUTLINE_TOOL, OUTLINE_SYSTEM,
			outlinePrompt(meta.spec, claimsDigest, synthesesDigest),
			{ signal: deps.signal, temperature: 0.4 },
		);
		await store.saveOutline({ sections, created_at: new Date().toISOString() });

		// Per-section drafting in parallel (bounded) — each section gets its own
		// evidence bundle: citation-ready claims + counterevidence + assumptions.
		progress(`Drafting ${sections.length} sections in parallel…`);
		const sectionDrafts = await runParallel(
			sections,
			async (section) => {
				const sectionClaims = section.claim_ids
					.map((id) => claims[Number(id.replace(/^C/i, "")) - 1])
					.filter((c): c is Claim => !!c && c.citation_ready);
				const bundle = sectionClaims
					.map((c, i) => {
						const globalIdx = claims.indexOf(c) + 1;
						const srcNums = c.source_ids.map((sid) => sources.findIndex((s) => s.id === sid) + 1).filter((n) => n > 0);
						return `C${globalIdx} [${c.status}, conf ${c.confidence.toFixed(2)}] ${c.text} | cite as: ${srcNums.map((n) => `[${n}]`).join(" ")}`;
					})
					.join("\n");
				const assumptions = sectionClaims
					.flatMap((c) => c.assumptions)
					.filter((a, i, arr) => arr.indexOf(a) === i)
					.map((a) => `- ${a}`)
					.join("\n") || "(none)";
				const draft = await llmText(
					deps.handle, SECTION_SYSTEM,
					sectionPrompt(meta.spec!, section, bundle || "(no citation-ready claims — state this gap)", assumptions),
					{ signal: deps.signal, temperature: 0.4, maxTokens: 4000, timeoutMs: 180_000 },
				);
				return { section, draft };
			},
			2,
			deps.signal,
		);

		const writtenSections = successes(sectionDrafts);
		progress("Writing executive summary…");
		const execSummary = await llmText(
			deps.handle, EXEC_SUMMARY_SYSTEM,
			execSummaryPrompt(meta.spec, sections.map((s) => s.title), synthesesDigest),
			{ signal: deps.signal, temperature: 0.3, maxTokens: 1500, timeoutMs: 120_000 },
		);

		// Assemble: title → exec summary → sections → sources
		const srcList = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}${s.date ? ` (${s.date})` : ""}`).join("\n");
		const contradictionNote =
			contradictions.length > 0
				? `\n\n## Contradictions Detected\n\n${contradictions
						.map((e) => `- **${claims.find((c) => c.id === e.from)?.text}** vs **${claims.find((c) => c.id === e.to)?.text}** — ${e.reason ?? "unresolved"}`)
						.join("\n")}\n`
				: "";
		const report =
			`# ${meta.spec.objective}\n\n` +
			`**Research date:** ${new Date().toISOString().slice(0, 10)} · **Sources analyzed:** ${sources.length} · **Evidence records:** ${allEvidence.length} · **Verified claims:** ${claims.length}\n\n---\n\n` +
			`## Executive Summary\n\n${execSummary}\n\n---\n\n` +
			writtenSections.map((s) => s.draft.trim()).join("\n\n---\n\n") +
			contradictionNote +
			`\n\n## Sources\n\n${srcList}\n`;

		// ── Phase 8: audits + citation repair (§22.1) ────────────────────────
		checkAbort();
		progress("Running citation + quality audits…");
		const citationAudit = await auditCitations(deps.handle, report, sources, allEvidence, deps.signal);

		// repair pass: re-cite or hedge failed citations instead of just flagging
		let finalReport = report;
		if (citationAudit.failures.length > 0) {
			progress(`Repairing ${citationAudit.failures.length} failed citations…`);
			const failureDigest = citationAudit.failures
				.map((f) => `- SENTENCE: ${f.sentence.slice(0, 200)}\n  CITED: ${f.citation} | PROBLEM: ${f.problem.slice(0, 150)}`)
				.join("\n");
			const srcListForRepair = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n");
			const { repairs } = await llmJson<{ repairs: Array<{ sentence_prefix: string; action: "recite" | "drop_citation" | "keep"; new_citation?: number; reason: string }> }>(
				deps.handle, CITATION_REPAIR_TOOL, CITATION_REPAIR_SYSTEM,
				citationRepairPrompt(failureDigest, srcListForRepair),
				{ signal: deps.signal, temperature: 0.2 },
			);
			let repaired = 0;
			for (const rep of repairs) {
				const failure = citationAudit.failures.find((f) => f.sentence.startsWith(rep.sentence_prefix.slice(0, 30)) || f.sentence.includes(rep.sentence_prefix.slice(0, 30)));
				if (!failure) continue;
				if (rep.action === "recite" && rep.new_citation && rep.new_citation <= sources.length) {
					finalReport = finalReport.replace(failure.sentence + failure.citation, failure.sentence + `[${rep.new_citation}]`);
					repaired++;
				} else if (rep.action === "drop_citation") {
					finalReport = finalReport.replace(failure.sentence + failure.citation, failure.sentence + " (inference — no direct source)");
					repaired++;
				}
			}
			await store.log("citation_repair", { attempted: repairs.length, applied: repaired });
		}

		const staticAudits = runStaticAudits({
			spec: meta.spec,
			tasks,
			sources,
			evidence: allEvidence,
			claims,
			edges,
			report,
			injectionFlags: [...new Set(injectionFlags)],
		});
		const audit = assembleAudit(staticAudits, citationAudit);
		await store.saveAudit(audit);

		const auditNote = audit.overall_pass ? "" : `\n\n---\n\n## Audit warnings\n${renderAuditWarnings(audit)}`;
		await store.saveReport(finalReport + numericSection + auditNote);

		meta.status = "completed";
		await store.saveMeta(meta);
		progress(
			`✓ ${sources.length} sources · ${allEvidence.length} evidence · ${claims.length} claims · ${edges.length} edges · audit ${audit.overall_pass ? "PASS" : "WARNINGS"}`,
		);

		return {
			runId,
			report: finalReport + numericSection + auditNote,
			meta,
			sources,
			evidence: allEvidence,
			claims,
			edges,
			audit,
			reportFile: store.reportFile(),
		};
	} catch (err) {
		const aborted = (err as Error & { aborted?: boolean })?.aborted;
		meta.status = aborted ? "interrupted" : "failed";
		await store.saveMeta(meta);
		await store.log("run_error", { aborted: !!aborted, error: String(err) });
		throw err;
	}
}

// ── source pipeline (one full agent role per source, §26) ────────────────
async function sourcePipeline(
	res: SearchResult,
	task: Task,
	existingSources: Source[],
	existingEvidence: Evidence[],
	deps: OrchestratorDeps,
	topicKeywords: string[],
): Promise<SourceOutcome> {
	const canon = canonicalUrl(res.url);
	if (existingSources.some((s) => s.url_canonical === canon)) {
		return { result: res, evidence: [], skipReason: "canonical-url" };
	}

	const doc = await ingestUrl(res.url, { signal: deps.signal, maxChars: 40_000, timeoutMs: 45_000 });
	if (doc.text.trim().length < 200) return { result: res, evidence: [], skipReason: "too-short" };

	// dedup (§17): hash + simhash near-dup
	const known = existingSources.map((s) => ({
		url: s.url,
		hash: s.hash,
		fingerprint: BigInt("0x" + (s.fingerprint ?? "0")),
	}));
	const dup = checkDuplicate(res.url, doc.text, known);
	if (dup.isDuplicate) return { result: res, evidence: [], skipReason: dup.reason ?? "duplicate" };

	// novelty gate (§17.2)
	const knownTexts = existingEvidence.map((e) => e.claim + " " + (e.quote ?? ""));
	const nov = novelty(doc.text, knownTexts);
	if (nov < NOVELTY_FLOOR && knownTexts.length > 3) {
		return { result: res, evidence: [], skipReason: "low-novelty" };
	}

	// passage selection (§8): chunk → BM25 rank → budgeted context
	const passages = chunkDocument(doc.text);
	const selected = selectPassages(task.question + " " + (task.completion_test ?? ""), passages, EXTRACT_CHAR_BUDGET);
	const context = assembleContext(selected);

	// trust: untrusted data plane envelope (§24)
	const wrapped = wrapUntrusted(`${doc.title} (${res.url})`, context, doc.trust);

	const extracted = await llmJson<ExtractToolArgs>(
		deps.handle, EXTRACT_TOOL, EXTRACT_SYSTEM, extractPrompt(task, doc.title, doc.url, wrapped),
		{ signal: deps.signal, temperature: 0.2 },
	);

	if (extracted.evidence.length === 0) {
		return { result: res, evidence: [], skipReason: "no-evidence", injection: extracted.injection_detected };
	}

	// source-quality features (§10)
	const features = assessSourceQuality({
		url: res.url,
		title: doc.title,
		contentType: doc.contentType,
		kind: doc.kind,
		text: doc.text,
		date: doc.date,
		topicKeywords,
	});
	const composite = compositeQuality(features);

	const source: Source = {
		id: `s${existingSources.length + 1}`, // provisional; renumbered centrally
		url: res.url,
		url_canonical: canon,
		title: doc.title || res.title,
		publisher: hostOf(res.url),
		date: doc.date,
		quality: qualityLabel(composite),
		quality_features: features,
		hash: contentHash(doc.text),
		fingerprint: simhash(doc.text).toString(16),
	};

	const evidence: Evidence[] = extracted.evidence.map((e, i) => ({
		id: `tmp_${source.id}_${i}`, // renumbered centrally
		task_id: task.id,
		source_id: source.id,
		claim: e.claim,
		values: e.values,
		conditions: e.conditions,
		confidence: clamp01(e.confidence),
		quote: e.quote,
	}));

	// source memo (tier 2 summarization, §13.3) — parallel with other sources
	const memo = await llmJson<{ purpose: string; key_findings: string[]; limitations: string[] }>(
		deps.handle, SOURCE_MEMO_TOOL, SOURCE_MEMO_SYSTEM,
		sourceMemoPrompt(task.question, doc.title, res.url, evidence.map((e) => `- ${e.claim}${e.conditions ? ` (${e.conditions})` : ""}`).join("\n")),
		{ signal: deps.signal, temperature: 0.2 },
	);

	return {
		result: res,
		doc,
		source,
		evidence,
		memo: { source_id: source.id, ...memo, relevant_claims: [] },
		rawText: doc.text,
		injection: extracted.injection_detected,
	};
}

// ── task graph scheduling (§4) ───────────────────────────────────────────
/** Ready = open AND all dependencies done. Ordered by priority, then depth. */
function readyTasks(tasks: Task[]): Task[] {
	const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
	return tasks
		.filter((t) => t.status === "open" && (t.depends_on ?? []).every((d) => doneIds.has(d)))
		.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
}

/** Relation-check pairs: shared sources and high confidence first. */
function prioritizePairs(claims: Claim[]): Array<[Claim, Claim]> {
	const pairs: Array<[Claim, Claim, number]> = [];
	for (let i = 0; i < claims.length; i++) {
		for (let j = i + 1; j < claims.length; j++) {
			const a = claims[i];
			const b = claims[j];
			const sharedSources = a.source_ids.filter((s) => b.source_ids.includes(s)).length;
			pairs.push([a, b, sharedSources * 2 + a.confidence + b.confidence]);
		}
	}
	pairs.sort((x, y) => y[2] - x[2]);
	return pairs.map(([a, b]) => [a, b]);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function clamp01(n: number): number {
	const x = Number(n);
	if (Number.isNaN(x)) return 0.5;
	return Math.max(0, Math.min(1, x));
}

function renderAuditWarnings(a: AuditReport): string {
	const lines: string[] = [];
	if (!a.coverage.pass) lines.push(`- Uncovered dimensions: ${a.coverage.uncovered.join(", ")}`);
	if (!a.claim_audit.pass) lines.push(`- Unsupported claims: ${a.claim_audit.unsupported.join(", ")}`);
	if (!a.citation_audit.pass)
		lines.push(
			`- Citation failures (${a.citation_audit.failures.length}/${a.citation_audit.checked}): ${a.citation_audit.failures
				.slice(0, 5)
				.map((f) => f.problem)
				.join("; ")}`,
		);
	if (a.contradiction_audit.unresolved > 0) lines.push(`- ${a.contradiction_audit.unresolved} contradiction edge(s) detected`);
	if (!a.numerical.pass) lines.push(`- Unit inconsistencies: ${a.numerical.suspicious.join("; ")}`);
	if (!a.source_diversity.pass) lines.push(`- Source diversity low: dominant publisher share ${(a.source_diversity.dominant_share * 100).toFixed(0)}%`);
	if (a.safety.injected_sources > 0) lines.push(`- ${a.safety.injected_sources} source(s) contained injection-like content (sandboxed, reported)`);
	return lines.join("\n");
}
