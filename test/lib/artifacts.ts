// test/lib/artifacts.ts — artifact manager for test results.
//
// All file I/O for the judge framework goes through here.
// One responsibility: read/write structured artifacts to test/results/<slug>/.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const RESULTS_ROOT = "test/results";

export function slugify(topic: string): string {
	return topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

export function topicDir(slug: string): string {
	return join(RESULTS_ROOT, slug);
}

export async function ensureTopicDir(slug: string): Promise<string> {
	const dir = topicDir(slug);
	await mkdir(dir, { recursive: true });
	return dir;
}

// ── reports ──────────────────────────────────────────────────────────────

export async function saveReport(
	dir: string,
	source: "ours" | "drh",
	text: string,
): Promise<void> {
	const filename = source === "ours" ? "ours_report.md" : "drh_report.md";
	await writeFile(join(dir, filename), text, "utf8");
}

export async function loadReport(
	dir: string,
	source: "ours" | "drh",
): Promise<string | null> {
	const filename = source === "ours" ? "ours_report.md" : "drh_report.md";
	const path = join(dir, filename);
	if (!existsSync(path)) return null;
	return await readFile(path, "utf8");
}

// ── generic JSON ─────────────────────────────────────────────────────────

export async function saveJson<T>(dir: string, name: string, data: T): Promise<void> {
	await writeFile(join(dir, name), JSON.stringify(data, null, 2), "utf8");
}

export async function loadJson<T>(dir: string, name: string): Promise<T | null> {
	const path = join(dir, name);
	if (!existsSync(path)) return null;
	return JSON.parse(await readFile(path, "utf8")) as T;
}

// ── verdict ──────────────────────────────────────────────────────────────

export async function saveVerdict(dir: string, verdict: unknown): Promise<void> {
	await saveJson(dir, "verdict.json", verdict);
}

export async function loadVerdict<T = unknown>(dir: string): Promise<T | null> {
	return await loadJson<T>(dir, "verdict.json");
}

// ── TTL-based reference management (§3.2) ────────────────────────────────

export async function isReferenceStale(
	dir: string,
	ttlDays: number,
): Promise<boolean> {
	const metaPath = join(dir, "drh_meta.json");
	if (!existsSync(metaPath)) return true;
	try {
		const meta = JSON.parse(await readFile(metaPath, "utf8"));
		const generated = meta.timestamp ? new Date(meta.timestamp).getTime() : 0;
		const ageDays = (Date.now() - generated) / (1000 * 60 * 60 * 24);
		return ageDays > ttlDays;
	} catch {
		return true;
	}
}

export async function invalidateReference(dir: string): Promise<void> {
	// Remove all reference-dependent artifacts when reference expires
	for (const f of ["drh_report.md", "drh_meta.json", "juror-run1.json", "juror-run2.json", "verdict.json"]) {
		const path = join(dir, f);
		if (existsSync(path)) await rm(path);
	}
}

// ── log ──────────────────────────────────────────────────────────────────

export async function appendLog(dir: string, entry: unknown): Promise<void> {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
	await writeFile(join(dir, "log.jsonl"), line, { flag: "a", encoding: "utf8" });
}
