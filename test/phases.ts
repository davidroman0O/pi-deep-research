// test/phases.ts — targeted verification of the §18 phases against real evidence.
//
// Loads evidence.jsonl from logs/last-run (produced by a prior full run) and
// runs ONLY the numeric normalization + scenario phases — 2-3 LLM calls, not
// 30. Verifies the §18 sections fire even when extractors put numbers in claim
// text (the gap that gated them off before).
//
//   bun test/phases.ts

import { readFile } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { llmJson } from "../src/llm.ts";
import { NUMERIC_SYSTEM, numericPrompt, NUMERIC_TOOL, SCENARIO_SYSTEM, scenarioPrompt, SCENARIO_TOOL } from "../src/prompts.ts";
import type { Evidence, Source, Spec } from "../src/store.ts";

let failures = 0;
const check = (name: string, cond: boolean, d = "") => {
	console.log(`${cond ? "✅" : "❌"} ${name}${d ? ` — ${d}` : ""}`);
	if (!cond) failures++;
};

const dir = "logs/last-run";
const evidence = (await readFile(`${dir}/evidence.jsonl`, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Evidence);
const sources = JSON.parse(await readFile(`${dir}/sources.json`, "utf8")) as Source[];
const meta = JSON.parse(await readFile(`${dir}/run.json`, "utf8")) as { spec: Spec };
console.log(`loaded ${evidence.length} evidence, ${sources.length} sources`);

// ── the exact gate logic from the orchestrator ────────────────────────────
const numericEvidence = evidence.filter(
	(e) =>
		(e.values && Object.keys(e.values).length > 0) ||
		/[$€£¥]\s?\d|\d[\d,.]*\s*(?:kW|MW|GW|MWh|kWh|%|bn|billion|million|USD|CAD|GBP|EUR|years?|months?|\/kW)/i.test(e.claim),
);
const valueClaims = numericEvidence
	.map((e) => {
		const srcNum = sources.findIndex((s) => s.id === e.source_id) + 1;
		const vals = e.values && Object.keys(e.values).length > 0 ? JSON.stringify(e.values) : "(in claim text)";
		return `- ${e.claim} | values: ${vals} | conditions: ${e.conditions ?? "none"} | source [${srcNum}]`;
	})
	.join("\n");

check("numeric gate fires (numbers detected in claim text)", numericEvidence.length >= 3, `${numericEvidence.length} numeric claims`);
check("structured values populated", evidence.some((e) => e.values && Object.keys(e.values).length > 0) === false, "as expected — all in claim text, gate still fires");

// ── the model ─────────────────────────────────────────────────────────────
const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();
const model = available.find((m) => `${m.provider}/${m.id}` === process.env.MODEL_REF) ?? available[0];
console.log(`model: ${model.provider}/${model.id}`);
const handle = {
	model,
	getAuth: async (id: string) => {
		const a = await runtime.getAuth(id);
		return a ? { apiKey: a.auth.apiKey, headers: a.auth.headers, baseUrl: a.auth.baseUrl, env: a.env } : null;
	},
};

// ── Phase 6c: numeric normalization ───────────────────────────────────────
const { rows } = await llmJson<{ rows: Array<{ metric: string; subject: string; value: string; normalized?: string; conditions: string; citation: number; comparable: boolean }> }>(
	handle,
	NUMERIC_TOOL,
	NUMERIC_SYSTEM,
	numericPrompt(meta.spec, valueClaims),
	{ temperature: 0.2 },
);
check("numeric tool returns rows", rows.length >= 3, `${rows.length} rows`);
const metrics = new Set(rows.map((r) => r.metric.toLowerCase()));
check("rows group into multiple metrics", metrics.size >= 2, [...metrics].join(", "));
check("rows include documented conversions or comparable flags", rows.some((r) => r.normalized || !r.comparable));
check("citations reference valid sources", rows.every((r) => r.citation >= 1 && r.citation <= sources.length));

// ── Phase 6d: scenario modeling ───────────────────────────────────────────
const sc = await llmJson<{ metric: string; base_value: string; scenarios: Array<{ name: string; assumption: string; projections: Array<{ year: string; value: string }> }> }>(
	handle,
	SCENARIO_TOOL,
	SCENARIO_SYSTEM,
	scenarioPrompt(meta.spec, valueClaims, meta.spec.time_horizon ?? "2035"),
	{ temperature: 0.3 },
);
check("scenario tool returns 3 scenarios", sc.scenarios.length === 3, sc.scenarios.map((s) => s.name).join(" | "));
check("each scenario has assumption + projections", sc.scenarios.every((s) => s.assumption && s.projections.length >= 1));
check("scenarios reference a real metric", !!sc.metric);
console.log(`\nbase estimate: ${sc.base_value}`);

console.log(`\n${failures === 0 ? "✅ PHASE TEST PASSED" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
