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
import { canonicalUrl, contentHash, simhash, checkDuplicate, novelty, detectSourceFamily } from "./novel.ts";
import {
	clusterClaims,
	claimClusterCandidates,
	coalesceClaimClusters,
	clusterRelationInput,
	buildClaim,
	relationInput,
	toEdge,
	type ClaimRelation,
} from "./claimgraph.ts";
import { assessSourceQuality, compositeQuality, qualityLabel } from "./quality.ts";
import { defaultRequiredEvidence, createBudget, isBudgetExhausted, guardAction, transitionState, isTaskComplete, selectVerificationTargets, MAX_ATTEMPTS_PER_TASK } from "./controller.ts";
import { buildCoverageMatrix } from "./coverage.ts";
import { buildSnapshot, chooseAction, type MemorySnapshot } from "./policy.ts";
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
	SCENARIO_SYSTEM, scenarioPrompt, SCENARIO_TOOL,
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
		proposition_key?: string;
		target_relation?: "supports" | "duplicate" | "contradicts" | "qualifies" | "unrelated";
		values?: Record<string, string | number>;
		conditions?: string;
		confidence: number;
		quote?: string;
	}>;
	injection_detected?: string[];
}

export function prepareVerificationEvidence(
	evidence: ExtractToolArgs["evidence"],
	targetPropositionKey: string,
): ExtractToolArgs["evidence"] {
	// ponytail: Evidence has no stance field; persist non-support when typed target edges exist.
	return evidence
		.filter((e) => e.target_relation === "supports" || e.target_relation === "duplicate")
		.map((e) => ({ ...e, proposition_key: targetPropositionKey }));
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
const MAX_TOTAL_TASKS = 40;
const TASK_CONCURRENCY = 2; // tasks researched in parallel (§26 bounded fan-out)
const SOURCE_CONCURRENCY = 3; // sources ingested/extracted in parallel per task
const EXTRACT_CHAR_BUDGET = 14_000; // §13.2 budgeted context assembly
const VERIFY_SAFETY_NET_CLAIMS = 3; // §15 — corroborate up to N single-sourced claims/task (was 1)

export function sourceLimitForAction(maxSources: number, action: string): number {
	return action === "search" ? Math.max(1, maxSources - VERIFY_SAFETY_NET_CLAIMS) : maxSources;
}

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
				state: "open" as const,
				depends_on: [],
				coverage: 0,
				uncertainty: 1,
				required_evidence: defaultRequiredEvidence(t.priority),
				search_attempts: 0,
			}));
			await store.saveTasks(tasks);
		}

		// ── Phases 3-5: dynamic loop over the ready set ────────────────────
		let sources = await store.loadSources();
		const sourceMemos: SourceMemo[] = await store.loadSourceMemos();
		const taskMemos: TaskMemo[] = await store.loadTaskMemos();

		// ── CONTROLLER LOOP (§14) ─────────────────────────────────────────
		const budget = createBudget(config);
		let consecutiveLowNovelty = 0;

		while (meta.stats.iterations < config.max_iterations && sources.length < config.max_sources) {
			checkAbort();

			// refresh: coverage matrix (§16 — deterministic, no model call)
			const _allEvidence = await store.loadEvidence();
			const _allClaims = await store.loadClaims();
			const _allEdges = await store.loadEdges();
			const covMatrix = buildCoverageMatrix(meta.spec!, tasks, _allEvidence, _allClaims, sources, _allEdges);

			// select next task — highest gapScore from open tasks
			const openTasks = tasks.filter((t) => t.status === "open" || t.status === "in_progress");
			if (openTasks.length === 0) break;

			const taskGapScores = new Map(covMatrix.tasks.map((tc) => [tc.taskId, tc.gapScore]));
			const task = openTasks.sort((a, b) =>
				(taskGapScores.get(b.id) ?? 0) - (taskGapScores.get(a.id) ?? 0) ||
				b.priority - a.priority,
			)[0];
			task.status = "in_progress";
			await store.saveTasks(tasks);
			progress(`[iter ${meta.stats.iterations + 1}] ${task.id}: ${task.question.slice(0, 60)}…`);

			// ── TASK ACTION LOOP (§14 inner loop) ──────────────────────────
			let taskActions = 0;
			while (true) {
				checkAbort();

				// refresh task state from evidence
				const taskEvidence = (await store.loadEvidence()).filter((e) => e.task_id === task.id);
				const taskEdges = await store.loadEdges();
				task.state = transitionState(task, taskEvidence, sources, taskEdges);

				// completion check (§4.2)
				if (isTaskComplete(task, await store.loadEvidence(), sources, taskEdges)) break;
				if (isBudgetExhausted(budget)) { progress(`  ⚠ budget exhausted`); break; }

				// model chooses action (§15)
				// The persisted claim graph is built after this loop; expose live claims when verify is actionable.
				const { clusterClaims } = await import("./claimgraph.ts");
				const snapshotClaims = task.state === "corroboration"
					? clusterClaims(taskEvidence).map((cluster, i) => ({ id: `live-${task.id}-${i + 1}`, text: cluster[0]?.claim ?? "", status: "unknown", supporting_evidence: [], contradicting_evidence: [], assumptions: [], confidence: Math.max(...cluster.map((e) => e.confidence)), citation_ready: false, evidence_ids: cluster.map((e) => e.id), source_ids: [...new Set(cluster.map((e) => e.source_id))] }))
					: _allClaims;
				const snapshot = buildSnapshot(meta.spec!, tasks, snapshotClaims, _allEdges, sources, config,
					covMatrix.dimensions.filter((d) => d.status === "complete").map((d) => d.name),
					covMatrix.openDimensions);
				const action = await chooseAction(deps.handle, task, snapshot, deps.signal);

				// guard (state machine + safety)
				const guarded = guardAction(action, task, budget);
				if (guarded.coerced) await store.log("action_coerced", { from: action.type, to: guarded.type, reason: guarded.reason });
				progress(`  ▸ ${guarded.type}${guarded.coerced ? " (coerced)" : ""} — ${action.reason?.slice(0, 60) ?? ""}`);

				budget.actionsUsed++;
				if (guarded.type === "search") task.search_attempts++;

				if (guarded.type === "stop" || guarded.type === "summarize") break;

				if (guarded.type === "search" || guarded.type === "verify") {
					const queries = action.queries?.length
						? action.queries.slice(0, config.max_search_queries)
						: (await llmJson<{ queries: string[] }>(deps.handle, QUERY_TOOL, QUERY_SYSTEM,
							queryPrompt(task, taskEvidence.map((e) => `- ${e.claim}`).join("\n")),
							{ signal: deps.signal, temperature: 0.6 })).queries.slice(0, config.max_search_queries);
					meta.stats.searches += queries.length;

					const allResults: SearchResult[] = [];
					for (const q of queries) {
						try { allResults.push(...(await search.search(q, deps.signal, config.breadth))); }
						catch (err) { await store.log("search_error", { query: q, error: String(err) }); }
					}
					const ranked = rankResults(allResults)
						.filter((r) => !sources.some((s) => s.url_canonical === canonicalUrl(r.url)))
						.slice(0, config.breadth);
					const sourceLimit = sourceLimitForAction(config.max_sources, guarded.type);

					for (const res of ranked) {
						checkAbort();
						if (sources.length >= sourceLimit) break;

						const known = sources.map((s) => ({ url: s.url, hash: s.hash, fingerprint: BigInt("0x" + (s.fingerprint ?? "0")) }));
						let doc;
						try { doc = await ingestUrl(res.url, { signal: deps.signal, maxChars: 40_000, timeoutMs: 45_000 }); }
						catch (err) { await store.log("ingest_error", { url: res.url, error: String(err) }); continue; }
						if (doc.text.trim().length < 200) continue;

						const dup = checkDuplicate(res.url, doc.text, known);
						if (dup.isDuplicate) { await store.log("duplicate_skipped", { url: res.url, reason: dup.reason }); continue; }

						const knownTexts = (await store.loadEvidence()).map((e) => e.claim + " " + (e.quote ?? ""));
						const nov = novelty(doc.text, knownTexts);
						const candidatePublisher = hostOf(res.url);
						const publisherAlreadyKnown = sources.some((s) => s.publisher === candidatePublisher);
						if (nov < NOVELTY_FLOOR && knownTexts.length > 3 && publisherAlreadyKnown) {
							await store.log("low_novelty_skipped", { url: res.url, novelty: nov }); continue;
						}

						const passages = chunkDocument(doc.text);
						const selected = selectPassages(task.question + " " + (task.completion_test ?? ""), passages, EXTRACT_CHAR_BUDGET);
						const wrapped = wrapUntrusted(`${doc.title} (${res.url})`, assembleContext(selected), doc.trust);

						const extracted = await llmJson<ExtractToolArgs>(deps.handle, EXTRACT_TOOL, EXTRACT_SYSTEM,
							extractPrompt(task, doc.title, doc.url, wrapped), { signal: deps.signal, temperature: 0.2 });

						const evidenceList = Array.isArray(extracted?.evidence) ? extracted.evidence : [];
						if (evidenceList.length === 0) { await store.log("no_evidence", { url: res.url, task: task.id }); continue; }

						const features = assessSourceQuality({ url: res.url, title: doc.title, contentType: doc.contentType,
							kind: doc.kind, text: doc.text, date: doc.date, topicKeywords });
						const composite = compositeQuality(features);
						const sourceId = `s${sources.length + 1}`;
						const source: Source = { id: sourceId, url: res.url, url_canonical: canonicalUrl(res.url),
							title: doc.title || res.title, publisher: candidatePublisher,
							source_family: detectSourceFamily(res.url, candidatePublisher), date: doc.date,
							quality: qualityLabel(composite), quality_features: features,
							hash: contentHash(doc.text), fingerprint: simhash(doc.text).toString(16) };
						sources.push(source);
						await store.saveRawSource(sourceId, doc.text);
						if (extracted.injection_detected?.length) injectionFlags.push(res.url);
						budget.sourcesUsed++;

						for (const e of evidenceList) {
							const ev: Evidence = { id: `e${meta.stats.evidence_extracted + 1}`, task_id: task.id, source_id: sourceId,
								claim: e.claim, proposition_key: e.proposition_key, values: e.values, conditions: e.conditions, confidence: clamp01(e.confidence), quote: e.quote };
							await store.appendEvidence(ev);
							meta.stats.evidence_extracted++;
						}

						const smemo = await llmJson<{ purpose: string; key_findings: string[]; limitations: string[] }>(
							deps.handle, SOURCE_MEMO_TOOL, SOURCE_MEMO_SYSTEM,
							sourceMemoPrompt(task.question, doc.title, res.url,
								evidenceList.map((e) => `- ${e.claim}${e.conditions ? ` (${e.conditions})` : ""}`).join("\n")),
							{ signal: deps.signal, temperature: 0.2 });
						sourceMemos.push({ source_id: sourceId, ...smemo, relevant_claims: [] });

						meta.stats.sources_ingested = sources.length;
						await store.saveSources(sources);
						await store.saveSourceMemos(sourceMemos);
						await store.saveMeta(meta);
						progress(`    +${extracted.evidence.length} evidence — ${candidatePublisher}`);
						await store.log("action", { task: task.id, action: guarded.type, reason: action.reason, queries, source: res.url });
					}
				}
				taskActions++;
				if (taskActions > MAX_ATTEMPTS_PER_TASK * 2) break;
			}

			// ── verify safety net (§15 — ensures corroboration even if model didn't choose verify) ──
			const postTaskEvidence = (await store.loadEvidence()).filter((e) => e.task_id === task.id);
			const singleSourced = selectVerificationTargets(postTaskEvidence, sources);
			// ponytail: no priority gate — the source-cap guard below already bounds
			// cost, and high-priority tasks run first so they can't be starved.
			// Gating on priority left low-priority tasks' high-confidence claims
			// permanently single-sourced, capping corroboratedFraction.
			if (singleSourced.length > 0 && sources.length < config.max_sources - 2) {
				checkAbort();
				const claimsToVerify = singleSourced.slice(0, VERIFY_SAFETY_NET_CLAIMS);
				progress(`  ⚡ verify safety net: ${singleSourced.length} single-sourced — corroborating ${claimsToVerify.length}`);
				let verifyClaimsTried = 0;
				for (const claimToVerify of claimsToVerify) {
					if (sources.length >= config.max_sources - 2) break;
					const targetPropositionKey = claimToVerify.proposition_key;
					if (!targetPropositionKey) continue;
					// ponytail: skip if an earlier verify this pass already lifted this claim to ≥2 families
					// — cheap family recount avoids a wasted search+ingest round.
					const famNow = new Map(sources.map((s) => [s.id, s.source_family ?? detectSourceFamily(s.url, s.publisher ?? "")]));
					const currentTaskEvidence = (await store.loadEvidence()).filter((e) => e.task_id === task.id);
					const targetCluster = clusterClaims(currentTaskEvidence)
						.find((cluster) => cluster.some((e) => e.id === claimToVerify.id));
					const targetFamilies = new Set(
						(targetCluster ?? [claimToVerify])
							.map((e) => famNow.get(e.source_id))
							.filter(Boolean) as string[],
					);
					if (targetFamilies.size >= 2) continue;
					verifyClaimsTried++;
					const verifySubject = claimToVerify.proposition_key
						?.split("|")
						.map((slot) => slot.trim())
						.filter((slot) => slot !== "none")
						.join(" ") || claimToVerify.claim;
					const verifyQueries = [
						`${verifySubject} independent analysis OR report OR study`,
						`${task.question.slice(0, 60)} corroboration OR comparison OR alternative estimate`,
					];
					const verifyResults: SearchResult[] = [];
					for (const vq of verifyQueries) {
						try { verifyResults.push(...(await search.search(vq, deps.signal, 8))); } catch {}
					}
					const verifyRanked = rankResults(verifyResults)
						.filter((r) => !sources.some((s) => s.url_canonical === canonicalUrl(r.url)) &&
							!targetFamilies.has(detectSourceFamily(r.url, hostOf(r.url))))
						.slice(0, 3);
					for (const res of verifyRanked) {
						checkAbort();
						if (sources.length >= config.max_sources) break;
						let vdoc;
						try { vdoc = await ingestUrl(res.url, { signal: deps.signal, maxChars: 40_000, timeoutMs: 45_000 }); }
						catch { continue; }
						if (vdoc.text.trim().length < 200) continue;
						const vdup = checkDuplicate(res.url, vdoc.text, sources.map((s) => ({ url: s.url, hash: s.hash, fingerprint: BigInt("0x" + (s.fingerprint ?? "0")) })));
						if (vdup.isDuplicate) continue;
						const verifyTask: Task = {
							...task,
							question: `Find independent evidence that supports, contradicts, or qualifies this exact claim: ${claimToVerify.claim}`,
							completion_test: `Set target_relation for every item. supports/duplicate require an exact match to ${targetPropositionKey}; use contradicts, qualifies, or unrelated otherwise.`,
						};
						const vpassages = chunkDocument(vdoc.text);
						const vselected = selectPassages(verifyTask.question, vpassages, EXTRACT_CHAR_BUDGET);
						const vwrapped = wrapUntrusted(`${vdoc.title} (${res.url})`, assembleContext(vselected), vdoc.trust);
						const vextracted = await llmJson<ExtractToolArgs>(deps.handle, EXTRACT_TOOL, EXTRACT_SYSTEM,
							extractPrompt(verifyTask, vdoc.title, res.url, vwrapped), { signal: deps.signal, temperature: 0.2 });
						const vlist = prepareVerificationEvidence(
							Array.isArray(vextracted?.evidence) ? vextracted.evidence : [],
							targetPropositionKey,
						);
						if (vlist.length === 0) continue;
						const vfeatures = assessSourceQuality({ url: res.url, title: vdoc.title, contentType: vdoc.contentType, kind: vdoc.kind, text: vdoc.text, date: vdoc.date, topicKeywords });
						const vcomposite = compositeQuality(vfeatures);
						const vsid = `s${sources.length + 1}`;
						sources.push({ id: vsid, url: res.url, url_canonical: canonicalUrl(res.url), title: vdoc.title || res.title,
							publisher: hostOf(res.url), source_family: detectSourceFamily(res.url, hostOf(res.url)), date: vdoc.date,
							quality: qualityLabel(vcomposite), quality_features: vfeatures, hash: contentHash(vdoc.text),
							fingerprint: simhash(vdoc.text).toString(16) });
						await store.saveRawSource(vsid, vdoc.text);
						for (const e of vlist) {
							await store.appendEvidence({ id: `e${meta.stats.evidence_extracted + 1}`, task_id: task.id, source_id: vsid,
								claim: e.claim, proposition_key: e.proposition_key, values: e.values, conditions: e.conditions, confidence: clamp01(e.confidence), quote: e.quote });
							meta.stats.evidence_extracted++;
						}
						// source memo for verify source
						const vsmemo = await llmJson<{ purpose: string; key_findings: string[]; limitations: string[] }>(
							deps.handle, SOURCE_MEMO_TOOL, SOURCE_MEMO_SYSTEM,
							sourceMemoPrompt(verifyTask.question, vdoc.title, res.url,
								vlist.map((e) => `- ${e.claim}${e.conditions ? ` (${e.conditions})` : ""}`).join("\n")),
							{ signal: deps.signal, temperature: 0.2 });
						sourceMemos.push({ source_id: vsid, ...vsmemo, relevant_claims: [] });
						await store.saveSourceMemos(sourceMemos);

						meta.stats.sources_ingested = sources.length;
						await store.saveSources(sources); await store.saveMeta(meta);
						progress(`    +${vlist.length} evidence (verify) — ${hostOf(res.url)}`);
						// ponytail: one independent hit resolves this pass; spend the budget on the next claim.
						break;
					}
				}
				await store.log("verify_safety_net", { task: task.id, single_sourced: singleSourced.length, corroborated: verifyClaimsTried });
			}

			// task memo (§13.3)
			task.state = "resolving";
			const allTaskEvidence = (await store.loadEvidence()).filter((e) => e.task_id === task.id);
			const taskSourceIds = new Set(allTaskEvidence.map((e) => e.source_id));
			const taskSourceMemos = sourceMemos.filter((m) => taskSourceIds.has(m.source_id));
			const memoDigest = taskSourceMemos.map((m) => `- [${m.source_id}] ${m.purpose}: ${(m.key_findings ?? []).join("; ")}`).join("\n");
			const memo = await llmJson<{ key_findings: string[]; limitations: string[]; open_issues: string[] }>(
				deps.handle, TASK_MEMO_TOOL, TASK_MEMO_SYSTEM,
				taskMemoPrompt(task, memoDigest || allTaskEvidence.map((e) => `- ${e.claim}`).join("\n") || "(no evidence found)"),
				{ signal: deps.signal, temperature: 0.3 });
			taskMemos.push({ task_id: task.id, key_findings: memo.key_findings,
				limitations: [...memo.limitations, ...memo.open_issues.map((i) => `open: ${i}`)],
				relevant_claims: allTaskEvidence.map((e) => e.id), created_at: new Date().toISOString() });
			await store.saveTaskMemos(taskMemos);

			task.status = "done"; task.state = "complete"; task.summary = memo.key_findings[0];
			await store.saveTasks(tasks);
			progress(`✓ ${task.id} done (${allTaskEvidence.length} evidence, ${task.search_attempts} actions)`);

			meta.stats.iterations++;
			await store.saveMeta(meta);

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
			for (const sq of gap.new_subquestions.slice(0, 5)) {
				if (tasks.length >= MAX_TOTAL_TASKS) break;
				if (config.max_iterations - meta.stats.iterations < 2) break;
				if (tasks.some((t) => t.question === sq)) continue;
				tasks.push({
					id: `t${tasks.length + 1}`,
					question: sq,
					priority: 6,
					depth: 1,
					status: "open",
					state: "open" as const,
					depends_on: doneIds.slice(-2),
					coverage: 0,
					uncertainty: 1,
					required_evidence: defaultRequiredEvidence(6),
					search_attempts: 0,
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
		const provisionalClusters = clusterClaims(allEvidence);
		const normalizationPairs = claimClusterCandidates(provisionalClusters);
		const normalizationOutcomes = await runParallel(
			normalizationPairs,
			async ([a, b]) => {
				const rel = await llmJson<{ relation: ClaimRelation | "unrelated"; reason?: string }>(
					deps.handle, RELATION_TOOL, RELATION_SYSTEM,
					relationPrompt(clusterRelationInput(provisionalClusters[a], provisionalClusters[b])),
					{ signal: deps.signal, temperature: 0 },
				);
				return { pair: [a, b] as [number, number], ...rel };
			},
			3,
			deps.signal,
		);
		const normalizationRelations = successes(normalizationOutcomes);
		const clusters = coalesceClaimClusters(
			provisionalClusters,
			normalizationRelations.filter((result) => result.relation === "duplicate").map((result) => result.pair),
		);
		const claims: Claim[] = clusters.map((cluster, i) => buildClaim(`c${i + 1}`, cluster, sources));
		await store.saveClaims(claims);

		const claimByEvidence = new Map<string, Claim>();
		for (const claim of claims) for (const evidenceId of claim.evidence_ids) claimByEvidence.set(evidenceId, claim);
		const checkedPairs = new Set<string>();
		const normalizationEdges: ClaimEdge[] = [];
		for (const result of normalizationRelations) {
			const a = claimByEvidence.get(provisionalClusters[result.pair[0]][0]?.id);
			const b = claimByEvidence.get(provisionalClusters[result.pair[1]][0]?.id);
			if (!a || !b || a.id === b.id) continue;
			checkedPairs.add(claimPairKey(a.id, b.id));
			if (result.relation !== "unrelated") normalizationEdges.push({ ...toEdge(a.id, b.id, result.relation), reason: result.reason });
		}

		const pairs = prioritizePairs(claims)
			.filter(([a, b]) => !checkedPairs.has(claimPairKey(a.id, b.id)))
			.slice(0, MAX_RELATION_CHECKS);
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
		const edgeByRelation = new Map<string, ClaimEdge>();
		for (const edge of [...normalizationEdges, ...successes(edgeOutcomes).filter((e): e is NonNullable<typeof e> => e !== null)]) {
			edgeByRelation.set(`${claimPairKey(edge.from, edge.to)}:${edge.relation}`, edge);
		}
		const edges = [...edgeByRelation.values()];
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
		// Numeric + scenario gates fire on EITHER structured `values` OR a number
		// detected in the claim text. Many extractors (e.g. glm-5-turbo) write
		// numbers into the claim prose and leave `values` empty — the §18
		// sections must still run for quantitative topics.
		const numericEvidence = allEvidence.filter(
			(e) => (e.values && Object.keys(e.values).length > 0) || /[$€£¥]\s?\d|\d[\d,.]*\s*(?:kW|MW|GW|MWh|kWh|%|bn|billion|million|USD|CAD|GBP|EUR|years?|months?|\/kW)/i.test(e.claim),
		);
		const valueClaims = numericEvidence
			.map((e) => {
				const srcNum = sources.findIndex((s) => s.id === e.source_id) + 1;
				const vals = e.values && Object.keys(e.values).length > 0 ? JSON.stringify(e.values) : "(in claim text)";
				return `- ${e.claim} | values: ${vals} | conditions: ${e.conditions ?? "none"} | source [${srcNum}]`;
			})
			.join("\n");
		let numericSection = "";
		if (numericEvidence.length >= 3) {
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

		// ── Phase 6d: scenario modeling (§18) ──────────────────────────────
		let scenarioSection = "";
		if (numericEvidence.length >= 3 && /\d{4}|20\d\d|horizon|projection|future|2030|2040|2050/i.test(meta.spec.time_horizon ?? "2035")) {
			checkAbort();
			progress("Modeling scenarios…");
			const sc = await llmJson<{ metric: string; base_value: string; scenarios: Array<{ name: string; assumption: string; projections: Array<{ year: string; value: string }> }> }>(
				deps.handle, SCENARIO_TOOL, SCENARIO_SYSTEM,
				scenarioPrompt(meta.spec, valueClaims, meta.spec.time_horizon ?? "2035"),
				{ signal: deps.signal, temperature: 0.3 },
			);
			const years = [...new Set(sc.scenarios.flatMap((s) => s.projections.map((p) => p.year)))].sort();
			const header = `| Scenario | Assumption | ${years.join(" | ")} |\n|---|---|${years.map(() => "---").join("|")}|`;
			const body = sc.scenarios
				.map((s) => `| ${s.name} | ${s.assumption} | ${years.map((y) => s.projections.find((p) => p.year === y)?.value ?? "—").join(" | ")} |`)
				.join("\n");
			// Render the projections as a mermaid line chart too — DR-heavy ships a
			// projected-trajectory figure; tables alone don't show the shape.
			const chart = renderScenarioChart(sc.metric, years, sc.scenarios);
			scenarioSection = `\n\n## Scenario Model: ${sc.metric}\n\n**Base estimate:** ${sc.base_value}\n\n${header}\n${body}\n\n${chart}\n`;
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

		const { sections: rawSections } = await llmJson<{ sections: Array<{ title: string; objective: string; claim_ids: string[] | string }> }>(
			deps.handle, OUTLINE_TOOL, OUTLINE_SYSTEM,
			outlinePrompt(meta.spec, claimsDigest, synthesesDigest),
			{ signal: deps.signal, temperature: 0.4 },
		);
		// The executive summary is generated separately after drafting — drop any
		// outline section that tries to write one (otherwise it appears twice).
		const sections = rawSections
			.filter((s) => !/executive\s+summary/i.test(s.title))
			.map((s) => ({
				...s,
				// Codex may return comma-separated ids despite the array schema.
				claim_ids: Array.isArray(s.claim_ids)
					? s.claim_ids
					: s.claim_ids.split(/\s*,\s*/).filter((id) => /^C\d+$/i.test(id)),
			}));
		await store.saveOutline({ sections, dropped: rawSections.length - sections.length, created_at: new Date().toISOString() });

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

				// §13 memory hierarchy retrieval: section reads Tier 4 (topic synthesis)
				// → Tier 3 (task memos) → Tier 2 (claims with citations), not raw claims only.
				// Match section to its dimension's topic synthesis + relevant task memos.
				const sectionKey = section.title.toLowerCase().split(" ")[0]?.slice(0, 12) ?? "";
				const relevantSynthesis = syntheses.find((s) =>
					s.dimension.toLowerCase().includes(sectionKey) || section.title.toLowerCase().includes(s.dimension.toLowerCase().slice(0, 10)),
				);
				const relevantMemos = taskMemos
					.filter((m) => m.key_findings.some((f) => f.toLowerCase().includes(sectionKey) ||
						section.title.toLowerCase().split(" ").some((w) => w.length > 4 && f.toLowerCase().includes(w))))
					.slice(0, 4);

				const hierarchyBundle = [
					relevantSynthesis ? `### Topic Synthesis (${relevantSynthesis.dimension})\n${relevantSynthesis.synthesis}` : "",
					relevantMemos.length > 0 ? `### Task Findings\n${relevantMemos.map((m) => `- ${(m.key_findings ?? []).join("; ")}${(m.limitations ?? []).length ? ` (limits: ${(m.limitations ?? []).slice(0,2).join("; ")})` : ""}`).join("\n")}` : "",
					bundle ? `### Verified Claims\n${bundle}` : "",
				].filter(Boolean).join("\n\n") || "(no citation-ready claims — state this gap)";

				const draft = await llmText(
					deps.handle, SECTION_SYSTEM,
					sectionPrompt(meta.spec!, section, hierarchyBundle, assumptions),
					{ signal: deps.signal, temperature: 0.4, maxTokens: 4000, timeoutMs: 180_000 },
				);
				return { section, draft };
			},
			2,
			deps.signal,
		);

		// Canonical headings: strip whatever heading the drafter chose and impose
		// the outline's own — guarantees one heading per section, no duplicates.
		const writtenSections = successes(sectionDrafts).map(({ section, draft }) => ({
			section,
			text: `## ${section.title}\n\n${stripLeadingHeadings(draft).trim()}`,
		}));
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
			`## Executive Summary\n\n${stripLeadingHeadings(execSummary).trim()}\n\n---\n\n` +
			writtenSections.map((s) => s.text).join("\n\n---\n\n") +
			contradictionNote +
			`\n\n## Sources\n\n${srcList}\n`;

		// ── Phase 8: audits + citation repair (§22.1) ────────────────────────
		checkAbort();
		progress("Running citation + quality audits…");
		const citationAudit = await auditCitations(deps.handle, report, sources, allEvidence, deps.signal, config.citation_checks ?? 25);

		// repair pass: re-cite or hedge failed citations instead of just flagging
		let finalReport = report;
		let citationsRepaired = 0;
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
			const keptSentences = new Set<string>();
			// The repair model paraphrases prefixes — match on normalized token
			// overlap instead of exact substring.
			const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 3));
			const matchFailure = (prefix: string) => {
				const pt = toks(prefix);
				let best: { f: (typeof citationAudit.failures)[0]; score: number } | null = null;
				for (const f of citationAudit.failures) {
					const ft = toks(f.sentence);
					let shared = 0;
					for (const t of pt) if (ft.has(t)) shared++;
					const score = shared / Math.max(1, pt.size);
					if (!best || score > best.score) best = { f, score };
				}
				return best && best.score >= 0.5 ? best.f : undefined;
			};
			for (const rep of repairs) {
				const failure = matchFailure(rep.sentence_prefix);
				if (!failure) continue;
				if (rep.action === "recite" && rep.new_citation && rep.new_citation <= sources.length) {
					const next = swapLastCitation(failure.raw, failure.citationNum, `[${rep.new_citation}]`);
					if (next && finalReport.includes(failure.raw)) {
						finalReport = finalReport.replace(failure.raw, next);
						repaired++;
					}
				} else if (rep.action === "drop_citation") {
					const next = swapLastCitation(failure.raw, failure.citationNum, "(inference — no direct source)");
					if (next && finalReport.includes(failure.raw)) {
						finalReport = finalReport.replace(failure.raw, next);
						repaired++;
					}
				} else if (rep.action === "keep") {
					// reviewer judged the flag a false positive — downgrade to reviewed
					keptSentences.add(failure.sentence);
				}
			}
			// remove reviewer-cleared items from the failure list
			citationAudit.failures = citationAudit.failures.filter((f) => !keptSentences.has(f.sentence));
			await store.log("citation_repair", { attempted: repairs.length, applied: repaired, cleared: keptSentences.size });
			citationsRepaired = repaired;
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
		// record repairs honestly: they were applied post-audit, not re-verified
		(audit.citation_audit as { repaired?: number }).repaired = citationsRepaired;
		await store.saveAudit(audit);

		const auditNote = audit.overall_pass ? "" : `\n\n---\n\n## Audit warnings\n${renderAuditWarnings(audit)}`;
		// numeric tables belong before the Sources list, not after it
		let assembled = finalReport;
		if (numericSection || scenarioSection) {
			const insert = numericSection + scenarioSection;
			assembled = /\n## Sources/.test(assembled)
				? assembled.replace(/\n## Sources/, insert + "\n\n## Sources")
				: assembled + insert;
		}

		// Citation map appendix (§22 reverse map: claim → source → verbatim quote)
		const citationMap =
			"\n\n## Citation Map\n\n_Each source with the verbatim evidence quotes extracted from it — passage-level traceability for every citation._\n" +
			sources
				.map((s, i) => {
					const quotes = allEvidence.filter((e) => e.source_id === s.id && e.quote).slice(0, 5);
					if (quotes.length === 0) return "";
					return `\n### [${i + 1}] ${s.title}\n${quotes.map((q) => `> "${q.quote}" — *supports: ${q.claim}*`).join("\n")}`;
				})
				.filter(Boolean)
				.join("\n");

		// Methodology disclosure (mechanical — DR-heavy-style transparency)
		const methodology =
			`\n\n## Methodology\n\n` +
			`- **Pipeline:** specification → task graph → ${meta.stats.iterations} research iterations (${meta.stats.searches} searches) → evidence extraction → claim graph → sectioned synthesis → citation + quality audits\n` +
			`- **Sources:** ${sources.length} ingested (${sources.map((s) => s.publisher).filter((v, i, a) => a.indexOf(v) === i).length} distinct publishers), ${allEvidence.length} evidence records, ${claims.length} verified claims, ${edges.length} relations (${contradictions.length} contradictions)\n` +
			`- **Model:** ${meta.model ?? "session model"} · **Run:** ${runId}\n` +
			`- **Audits:** citation entailment (${audit.citation_audit.checked} checked, ${audit.citation_audit.failures.length} unresolved), coverage ${audit.coverage.pass ? "pass" : "partial"}, source diversity ${(audit.source_diversity.dominant_share * 100).toFixed(0)}% max publisher share\n` +
			(meta.stats.sources_ingested >= meta.config.max_sources ? `- **Budget note:** source cap reached — deeper coverage available with a higher max_sources/profile.\n` : "");

		await store.saveReport(assembled + citationMap + methodology + auditNote);

		meta.status = "completed";
		await store.saveMeta(meta);
		progress(
			`✓ ${sources.length} sources · ${allEvidence.length} evidence · ${claims.length} claims · ${edges.length} edges · audit ${audit.overall_pass ? "PASS" : "WARNINGS"}`,
		);

		return {
			runId,
			report: assembled + citationMap + methodology + auditNote,
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

	// novelty gate (§17.2) — CORRECTED per DRH review C2:
	// low-novelty sources are skipped UNLESS they provide independent corroboration.
	// A source from a NEW publisher that restates a known claim is corroboration — KEEP it.
	// Only drop if low-novelty AND publisher already represented AND no new claim.
	const knownTexts = existingEvidence.map((e) => e.claim + " " + (e.quote ?? ""));
	const nov = novelty(doc.text, knownTexts);
	const candidatePublisher = hostOf(res.url);
	const publisherAlreadyKnown = existingSources.some((s) => s.publisher === candidatePublisher);
	if (nov < NOVELTY_FLOOR && knownTexts.length > 3 && publisherAlreadyKnown) {
		return { result: res, evidence: [], skipReason: "low-novelty-same-publisher" };
	}
	// low-novelty from a NEW publisher: log as corroboration-candidate, keep

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

	const publisher = hostOf(res.url);
	const source: Source = {
		id: `s${existingSources.length + 1}`, // provisional; renumbered centrally
		url: res.url,
		url_canonical: canon,
		title: doc.title || res.title,
		publisher,
		source_family: detectSourceFamily(res.url, publisher),
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
		proposition_key: e.proposition_key,
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

function claimPairKey(a: string, b: string): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
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

// ── helpers ──────────────────────────────────────────────────────────────
/** Pull the leading number out of a projection value string like "~$5,700/kW" or "6000". */
function numOf(s: string): number | null {
	const m = String(s).match(/-?\d[\d,.]*/);
	if (!m) return null;
	return Number(m[0].replace(/,/g, ""));
}

/** Mermaid xychart line chart of scenario projections (DR-heavy-style figure). */
function renderScenarioChart(
	metric: string,
	years: string[],
	scenarios: Array<{ name: string; projections: Array<{ year: string; value: string }> }>,
): string {
	if (years.length < 2) return "";
	const series = scenarios.map((s) => ({
		name: s.name.replace(/[\[\]]/g, "").slice(0, 28),
		points: years.map((y) => numOf(s.projections.find((p) => p.year === y)?.value ?? "")),
	}));
	// bail if nothing numeric to plot
	if (!series.some((s) => s.points.some((p) => p !== null))) return "";
	const lines = series.map((s) => `    ${JSON.stringify(s.name).replace(/"/g, "'")} : ${years.map((_, i) => s.points[i] ?? 0).join(", ")}`).join("\n");
	return [
		"```mermaid",
		"xychart-beta line",
		`	title "${metric.replace(/"/g, "'").slice(0, 60)} — scenario projection"`,
		`	x-axis [${years.map((y) => JSON.stringify(y).replace(/"/g, "'")).join(", ")}]`,
		"	y-axis \"value\" 0 --> " + (Math.max(...series.flatMap((s) => s.points.filter((p): p is number => p !== null)), 1000) * 1.15).toFixed(0),
		lines,
		"```",
	].join("\n");
}

/** Remove leading markdown heading lines from a draft (the assembler imposes canonical ones). */
function stripLeadingHeadings(text: string): string {
	return text.replace(/^(?:#{1,4}\s+[^\n]*\n+)+/, "");
}

/** Swap the LAST [oldN] citation in a report line; null when the citation is absent. */
export function swapLastCitation(raw: string, oldN: number, replacement: string): string | null {
	const needle = `[${oldN}]`;
	const idx = raw.lastIndexOf(needle);
	if (idx < 0) return null;
	return raw.slice(0, idx) + replacement + raw.slice(idx + needle.length);
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
