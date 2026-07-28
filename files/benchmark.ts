// test/benchmark.ts — config-matrix: does the system research *better*?
//
// Line count is vanity. This runs configs across backends and depths, then
// measures plurality, corroboration, coverage, citation integrity — answering:
//   • does Exa surface better sources than DDG?
//   • does ScrapeGraph extract better content than native?
//   • does deeper breadth raise corroboration?
//
// Each run is ~8-12 min; runs go in background, results land in logs/matrix/.
//
//   bun test/benchmark.ts <topic>            # default matrix
//   bun test/benchmark.ts "topic" --quick    # 2-config smoke matrix
//
// Results: logs/matrix/<ts>-<config>/report.md + a summary table at the end.

import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runResearch } from "../src/orchestrator.ts";
import { RunStore, PROFILES, type ResearchConfig } from "../src/store.ts";
import { saveConfig, type DrConfig } from "../src/config.ts";
import { computeMetrics, metricsRow, METRICS_HEADER, type ResearchMetrics } from "../src/metrics.ts";
import { join } from "node:path";

const TOPIC = process.argv[2] ?? "What is the current capital cost per kW of small modular reactors?";
const SMOKE = process.argv.includes("--quick");
const EXA = process.env.EXA_API_KEY!;
const SGAI = process.env.SCRAPEGRAPH_API_KEY ?? process.env.SGAI_API_KEY!;

// The matrix: backend combinations × depth.
interface MatrixCell {
	name: string;
	cfg: DrConfig;
	research: Partial<ResearchConfig>;
}
const ddg: DrConfig = { allowPaidBackends: false }; // forces ddg + native
const matrix: MatrixCell[] = SMOKE
	? [
			{ name: "ddg-only_quick", cfg: ddg, research: PROFILES.quick },
			{ name: "exa+sgai_standard", cfg: { search: "exa", scrape: "scrapegraph", exaApiKey: EXA, scrapegraphApiKey: SGAI }, research: {} },
		]
	: [
			{ name: "ddg-only", cfg: ddg, research: { breadth: 4, max_sources: 12, max_iterations: 4, max_search_queries: 3, depth: 1 } },
			{ name: "exa-only", cfg: { search: "exa", scrape: "native", exaApiKey: EXA, allowPaidBackends: true }, research: { breadth: 5, max_sources: 15, max_iterations: 5, max_search_queries: 4, depth: 2 } },
			{ name: "sgai-only", cfg: { search: "ddg", scrape: "scrapegraph", scrapegraphApiKey: SGAI, allowPaidBackends: true }, research: { breadth: 5, max_sources: 15, max_iterations: 5, max_search_queries: 4, depth: 2 } },
			{ name: "exa+sgai", cfg: { search: "exa", scrape: "scrapegraph", exaApiKey: EXA, scrapegraphApiKey: SGAI, allowPaidBackends: true }, research: { breadth: 5, max_sources: 15, max_iterations: 5, max_search_queries: 4, depth: 2 } },
		];

// Model
const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();
const model = available.find((m) => `${m.provider}/${m.id}` === process.env.MODEL_REF) ?? available[0];
const handle = {
	model,
	getAuth: async (id: string) => {
		const a = await runtime.getAuth(id);
		return a ? { apiKey: a.auth.apiKey, headers: a.auth.headers, baseUrl: a.auth.baseUrl, env: a.env } : null;
	},
};
console.log(`model: ${model.provider}/${model.id} | matrix: ${matrix.length} configs | topic: "${TOPIC.slice(0, 60)}…"\n`);

const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const matrixDir = `logs/matrix/${TS}`;
await mkdir(matrixDir, { recursive: true });
const summaryFile = `${matrixDir}/summary.md`;

await writeFile(summaryFile, `# Config matrix — ${TS}\n\n**Topic:** ${TOPIC}\n**Model:** ${model.provider}/${model.id}\n\n${METRICS_HEADER}\n`);

for (const cell of matrix) {
	console.log(`\n=== ${cell.name} ===`);
	await saveConfig(cell.cfg);
	const cellDir = `${matrixDir}/${cell.name}`;
	await mkdir(cellDir, { recursive: true });

	const t0 = Date.now();
	try {
		const result = await runResearch(TOPIC, {
			cwd: cellDir,
			handle,
			config: cell.research,
			onProgress: (line) => console.log(`  ▸ ${line}`),
		});
		const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
		const store = new RunStore(cellDir, result.runId);
		const m = computeMetrics(
			result.meta.spec!,
			result.sources,
			result.evidence,
			result.claims,
			result.edges,
			result.audit,
		);
		const row = metricsRow(cell.name, m);
		console.log(row);
		await appendFile(summaryFile, row + "\n");
		await appendFile(summaryFile, `_${cell.name}: ${elapsed}s | spec dims ${m.dimensionsTotal}_\n`);
	} catch (err) {
		const msg = `✗ ${cell.name} FAILED: ${(err as Error).message.slice(0, 120)}`;
		console.log(msg);
		await appendFile(summaryFile, msg + "\n");
	}
}

console.log(`\n=== SUMMARY (see ${summaryFile}) ===`);
console.log(await readFile(summaryFile, "utf8"));
