// src/config.ts — backend selection + key resolution.
//
// Three search backends and two scrape backends, all optional. Keys resolve
// from a config file first (~/.pi-deep-research.json), then env vars, then the
// built-in default (no-key DuckDuckGo + native fetch). The orchestrator and
// extension never hardcode a provider — they ask getSearchBackend/getScrapeBackend.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SearchBackendId = "ddg" | "tavily" | "exa" | "scrapegraph";
export type ScrapeBackendId = "native" | "scrapegraph";

export interface DrConfig {
	search?: SearchBackendId;
	scrape?: ScrapeBackendId;
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
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
	return next;
}

/** Resolve the configured search backend, honoring allowPaidBackends. */
export function resolveSearchBackend(cfg: DrConfig): SearchBackendId {
	const paid = cfg.allowPaidBackends !== false; // default true
	if (cfg.search) {
		if (cfg.search === "ddg") return "ddg";
		if (paid && hasSearchKey(cfg, cfg.search)) return cfg.search;
		return "ddg";
	}
	// auto: prefer a keyed paid backend, else fall back to no-key ddg
	if (paid) {
		if (cfg.exaApiKey || process.env.EXA_API_KEY) return "exa";
		if (cfg.tavilyApiKey || process.env.TAVILY_API_KEY) return "tavily";
		if (cfg.scrapegraphApiKey || process.env.SGAI_API_KEY) return "scrapegraph";
	}
	return "ddg";
}

/** Resolve the configured scrape backend. */
export function resolveScrapeBackend(cfg: DrConfig): ScrapeBackendId {
	const paid = cfg.allowPaidBackends !== false;
	if (cfg.scrape === "native") return "native";
	if (cfg.scrape === "scrapegraph" && paid && (cfg.scrapegraphApiKey || process.env.SGAI_API_KEY)) {
		return "scrapegraph";
	}
	return "native";
}

function hasSearchKey(cfg: DrConfig, id: SearchBackendId): boolean {
	if (id === "exa") return !!(cfg.exaApiKey || process.env.EXA_API_KEY);
	if (id === "tavily") return !!(cfg.tavilyApiKey || process.env.TAVILY_API_KEY);
	if (id === "scrapegraph") return !!(cfg.scrapegraphApiKey || process.env.SGAI_API_KEY);
	return true;
}

/** Resolve the effective API key for a backend (config file wins over env). */
export function resolveKey(cfg: DrConfig, id: SearchBackendId | ScrapeBackendId): string | undefined {
	switch (id) {
		case "exa":
			return cfg.exaApiKey || process.env.EXA_API_KEY;
		case "tavily":
			return cfg.tavilyApiKey || process.env.TAVILY_API_KEY;
		case "scrapegraph":
			return cfg.scrapegraphApiKey || process.env.SGAI_API_KEY;
		default:
			return undefined;
	}
}

/** A human-readable status line for the extension's widget/footer. */
export async function backendStatus(): Promise<string> {
	const cfg = await getConfig();
	const s = resolveSearchBackend(cfg);
	const sc = resolveScrapeBackend(cfg);
	return `search:${s} scrape:${sc}`;
}
