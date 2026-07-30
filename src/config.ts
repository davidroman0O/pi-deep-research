// src/config.ts — backend selection + key resolution.
//
// Multi-backend: multiple search and scrape backends can be enabled
// simultaneously. Keys resolve from config file first
// (~/.pi/agent/pi-deep-research.json), then env vars, then the built-in
// default (no-key DuckDuckGo + native fetch).

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SearchBackendId = "ddg" | "tavily" | "exa" | "scrapegraph";
export type ScrapeBackendId = "native" | "scrapegraph";

export interface DrConfig {
	/** Enabled search backends. If unset, auto-detect from keys + DDG always on. */
	enabledSearchBackends?: SearchBackendId[];
	/** Enabled scrape backends. If unset, native always, scrapegraph if key present. */
	enabledScrapeBackends?: ScrapeBackendId[];
	tavilyApiKey?: string;
	exaApiKey?: string;
	scrapegraphApiKey?: string;
	/** When false, use only no-cost backends regardless of keys. */
	allowPaidBackends?: boolean;
}

const CONFIG_FILE = join(getAgentDir(), "pi-deep-research.json");

export async function getConfig(): Promise<DrConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as DrConfig;
	} catch {
		return {};
	}
}

export async function saveConfig(updates: DrConfig): Promise<DrConfig> {
	const cur = await getConfig();
	const next = { ...cur, ...updates };
	for (const k of Object.keys(updates) as (keyof DrConfig)[]) {
		if (updates[k] === "" || updates[k] === undefined) delete (next as Record<string, unknown>)[k];
	}
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
	return next;
}

/** Resolve a ScrapeGraph key from config or env (accepts both SGAI_API_KEY and SCRAPEGRAPH_API_KEY). */
export function scrapegraphKey(cfg: DrConfig): string | undefined {
	return cfg.scrapegraphApiKey || process.env.SGAI_API_KEY || process.env.SCRAPEGRAPH_API_KEY;
}

/** Check if a search backend has a key (or is free). */
export function hasSearchKey(cfg: DrConfig, id: SearchBackendId): boolean {
	if (id === "exa") return !!(cfg.exaApiKey || process.env.EXA_API_KEY);
	if (id === "tavily") return !!(cfg.tavilyApiKey || process.env.TAVILY_API_KEY);
	if (id === "scrapegraph") return !!scrapegraphKey(cfg);
	return true; // ddg is free
}

/** Resolve the effective API key for a backend. */
export function resolveKey(cfg: DrConfig, id: SearchBackendId | ScrapeBackendId): string | undefined {
	switch (id) {
		case "exa": return cfg.exaApiKey || process.env.EXA_API_KEY;
		case "tavily": return cfg.tavilyApiKey || process.env.TAVILY_API_KEY;
		case "scrapegraph": return scrapegraphKey(cfg);
		default: return undefined;
	}
}

/** Resolve all ENABLED search backends (multi-backend). */
export function resolveEnabledSearchBackends(cfg: DrConfig): SearchBackendId[] {
	if (cfg.enabledSearchBackends && cfg.enabledSearchBackends.length > 0) {
		return cfg.enabledSearchBackends;
	}
	// Auto-detect: enable all keyed backends + DDG
	const result: SearchBackendId[] = ["ddg"];
	if (cfg.exaApiKey || process.env.EXA_API_KEY) result.push("exa");
	if (cfg.tavilyApiKey || process.env.TAVILY_API_KEY) result.push("tavily");
	if (scrapegraphKey(cfg)) result.push("scrapegraph");
	return result;
}

/** Resolve all ENABLED scrape backends (multi-backend). */
export function resolveEnabledScrapeBackends(cfg: DrConfig): ScrapeBackendId[] {
	if (cfg.enabledScrapeBackends && cfg.enabledScrapeBackends.length > 0) {
		return cfg.enabledScrapeBackends;
	}
	// Auto-detect: native always, scrapegraph if key
	const result: ScrapeBackendId[] = ["native"];
	if (scrapegraphKey(cfg)) result.push("scrapegraph");
	return result;
}

/** Backward compat: return first enabled search backend. */
export function resolveSearchBackend(cfg: DrConfig): SearchBackendId {
	return resolveEnabledSearchBackends(cfg)[0] ?? "ddg";
}

/** Backward compat: return first enabled scrape backend. */
export function resolveScrapeBackend(cfg: DrConfig): ScrapeBackendId {
	return resolveEnabledScrapeBackends(cfg)[0] ?? "native";
}

/** Human-readable description for prompts and UI. */
export function backendDescription(cfg: DrConfig): string {
	const search = resolveEnabledSearchBackends(cfg);
	const scrape = resolveEnabledScrapeBackends(cfg);
	const parts: string[] = [];
	const searchNames: Record<SearchBackendId, string> = {
		exa: "Exa neural search (semantic)", tavily: "Tavily (AI-optimized)",
		scrapegraph: "ScrapeGraph search (inline content)", ddg: "DuckDuckGo (keyword, free)",
	};
	const scrapeNames: Record<ScrapeBackendId, string> = {
		native: "native scrape (fetch+Readability, free)", scrapegraph: "ScrapeGraph scrape (JS rendering, anti-bot)",
	};
	if (search.length > 0) parts.push("Search: " + search.map(s => searchNames[s]).join(" + "));
	if (scrape.length > 0) parts.push("Scrape: " + scrape.map(s => scrapeNames[s]).join(" → fallback → "));
	return parts.join(". ") || "No backends configured.";
}

/** Status line for UI. */
export async function backendStatus(): Promise<string> {
	const cfg = await getConfig();
	const s = resolveEnabledSearchBackends(cfg);
	const sc = resolveEnabledScrapeBackends(cfg);
	return `search:[${s.join(",")}] scrape:[${sc.join(",")}]`;
}
