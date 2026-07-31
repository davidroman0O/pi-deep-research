// src/search.ts — search backends.
//
// Four providers behind one interface. Selection is config-driven
// (src/config.ts): exa (neural + deep research), tavily, scrapegraph (search +
// inline content), ddg (no-key fallback). No mocks, no fake providers — every
// backend hits its real API.

import Exa from "exa-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getConfig, resolveEnabledSearchBackends, resolveKey, type SearchBackendId } from "./config.ts";
import { canonicalUrl } from "./novel.ts";

// ── search result cache (DRH recommendation: freeze search between baseline/patched) ──
// When DR_SEARCH_CACHE points to a file:
//   - File exists → read-only mode (patched measure replays identical results)
//   - File missing → write mode (baseline measure builds the cache)
// This eliminates the 4-30% corroboration variance from search randomness.

interface SearchCache {
	[query: string]: SearchResult[];
}

let _cacheData: SearchCache | null = null;
let _cachePath: string | null = null;
let _cacheReadOnly = false;

function initCache(): void {
	_cachePath = process.env.DR_SEARCH_CACHE ?? null;
	if (!_cachePath) return;
	if (existsSync(_cachePath)) {
		_cacheData = JSON.parse(readFileSync(_cachePath, "utf8")) as SearchCache;
		_cacheReadOnly = true;
	} else {
		_cacheData = {};
	}
}

function cacheGet(query: string): SearchResult[] | null {
	if (!_cacheData) initCache();
	if (!_cacheData || !_cachePath) return null;
	const key = query.trim().toLowerCase();
	return _cacheData[key] ?? null;
}

function cachePut(query: string, results: SearchResult[]): void {
	if (!_cacheData) initCache();
	if (!_cacheData || !_cachePath || _cacheReadOnly) return;
	_cacheData[query.trim().toLowerCase()] = results;
	writeFileSync(_cachePath, JSON.stringify(_cacheData, null, 2), "utf8");
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	published?: string;
}

export interface SearchProvider {
	name: SearchBackendId;
	search(query: string, signal?: AbortSignal, limit?: number): Promise<SearchResult[]>;
}

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Resolve ALL enabled providers (multi-backend). */
export async function getSearchProviders(): Promise<SearchProvider[]> {
	const cfg = await getConfig();
	const backends = resolveEnabledSearchBackends(cfg);
	const providers: SearchProvider[] = [];
	for (const backend of backends) {
		if (backend === "exa") {
			const key = resolveKey(cfg, "exa");
			if (key) providers.push(new ExaProvider(key));
		} else if (backend === "tavily") {
			const key = resolveKey(cfg, "tavily");
			if (key) providers.push(new TavilyProvider(key));
		} else if (backend === "scrapegraph") {
			const key = resolveKey(cfg, "scrapegraph");
			if (key) providers.push(new ScrapeGraphSearchProvider(key));
		} else {
			providers.push(new DuckDuckGoProvider());
		}
	}
	return providers.length > 0 ? providers : [new DuckDuckGoProvider()];
}

/** Multi-backend search: queries ALL enabled providers in parallel, merges by URL. */
export class MultiSearchProvider implements SearchProvider {
	name: SearchBackendId = "ddg"; // composite
	private providers: SearchProvider[];
	constructor(providers: SearchProvider[]) { this.providers = providers; }
	async search(query: string, signal?: AbortSignal, limit = 8): Promise<SearchResult[]> {
		const perBackend = Math.max(3, Math.ceil(limit / this.providers.length));
		const results = await Promise.allSettled(
			this.providers.map(p => p.search(query, signal, perBackend)),
		);
		const merged = new Map<string, SearchResult>();
		for (const r of results) {
			if (r.status !== "fulfilled") continue;
			for (const item of r.value) {
				const key = canonicalUrl(item.url);
				if (!merged.has(key)) merged.set(key, item);
			}
		}
		return [...merged.values()].slice(0, limit);
	}
}

/** Backward compat: returns a single provider (MultiSearch if multiple enabled). */
export async function getSearchProvider(): Promise<SearchProvider> {
	const providers = await getSearchProviders();
	const base = providers.length === 1 ? providers[0] : new MultiSearchProvider(providers);
	return process.env.DR_SEARCH_CACHE ? new CachedSearchProvider(base) : base;
}

/** Wraps a provider with query→result caching for deterministic before/after comparison. */
class CachedSearchProvider implements SearchProvider {
	name: SearchBackendId;
	private inner: SearchProvider;
	constructor(inner: SearchProvider) { this.inner = inner; this.name = inner.name; }
	async search(query: string, signal?: AbortSignal, limit = 8): Promise<SearchResult[]> {
		const cached = cacheGet(query);
		if (cached) return cached.slice(0, limit);
		const results = await this.inner.search(query, signal, limit);
		cachePut(query, results);
		return results;
	}
}

/** Exa — neural search. Uses the official exa-js client. */
export class ExaProvider implements SearchProvider {
	name: SearchBackendId = "exa";
	private client: Exa;
	constructor(key: string) {
		this.client = new Exa(key);
	}
	async search(query: string, signal?: AbortSignal, limit = 8): Promise<SearchResult[]> {
		const res = await this.client.search(query, {
			numResults: limit,
			contents: { text: { maxCharacters: 400 }, highlights: true },
		});
		return (res.results ?? []).map((r) => ({
			title: r.title ?? r.url,
			url: r.url,
			snippet: (r as { text?: string }).text ?? "",
			published: r.publishedDate,
		}));
	}
}

/** Exa deep research — heavier, runs Exa's own multi-step synthesis. Optional power tool. */
export class ExaDeepProvider {
	private client: Exa;
	constructor(key: string) {
		this.client = new Exa(key);
	}
	async deepSearch(query: string, opts: { type?: "deep-lite" | "deep" | "deep-reasoning"; numResults?: number } = {}) {
		return this.client.search(query, {
			type: opts.type ?? "deep",
			numResults: opts.numResults ?? 10,
			contents: { text: { maxCharacters: 2000 }, highlights: true },
		});
	}
}

/** ScrapeGraphAI search — web search with page content returned inline. */
export class ScrapeGraphSearchProvider implements SearchProvider {
	name: SearchBackendId = "scrapegraph";
	constructor(private key: string) {}
	async search(query: string, signal?: AbortSignal, limit = 8): Promise<SearchResult[]> {
		const res = await fetch("https://v2-api.scrapegraphai.com/api/search", {
			method: "POST",
			headers: { "SGAI-APIKEY": this.key, "Content-Type": "application/json" },
			body: JSON.stringify({ query, numResults: Math.min(limit, 20), format: "markdown", mode: "prune" }),
			signal,
		});
		if (!res.ok) throw new Error(`ScrapeGraph search ${res.status}`);
		const data = (await res.json()) as {
			results?: Array<{ title?: string; url?: string; markdown?: string; description?: string }>;
		};
		return (data.results ?? [])
			.filter((r) => r.url)
			.map((r) => ({
				title: r.title ?? r.url!,
				url: r.url!,
				snippet: (r.markdown ?? r.description ?? "").slice(0, 400),
			}));
	}
}

/** Tavily — research-oriented search with clean snippets. */
export class TavilyProvider implements SearchProvider {
	name: SearchBackendId = "tavily";
	constructor(private key: string) {}
	async search(query: string, signal?: AbortSignal, limit = 8): Promise<SearchResult[]> {
		const res = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
			body: JSON.stringify({ query, max_results: limit, include_answer: false }),
			signal,
		});
		if (!res.ok) throw new Error(`Tavily ${res.status}`);
		const data = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
		return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
	}
}

/** DuckDuckGo — no key, default. Uses jina.ai proxy fallback when direct access is blocked. */
export class DuckDuckGoProvider implements SearchProvider {
	name: SearchBackendId = "ddg";
	private directFailed = false;

	async search(query: string, signal?: AbortSignal, limit = 8): Promise<SearchResult[]> {
		// Try direct DDG lite first (fast path when not blocked)
		if (!this.directFailed) {
			try {
				const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
				const res = await fetch(url, { headers: { "User-Agent": UA }, signal });
				if (res.ok) {
					const results = parseDuckDuckGoLite(await res.text());
					if (results.length > 0) return results.slice(0, limit);
				}
			} catch (err) {
				if (signal?.aborted) throw err;
			}
			this.directFailed = true;
		}

		// Fallback: jina.ai reader proxy (handles bot challenges, works globally)
		const proxyUrl = `https://r.jina.ai/https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		const res = await fetch(proxyUrl, { headers: { Accept: "text/plain" }, signal });
		if (!res.ok) throw new Error(`DuckDuckGo proxy ${res.status}`);
		return parseDuckDuckGoProxy(await res.text()).slice(0, limit);
	}
}

function parseDuckDuckGoLite(html: string): SearchResult[] {
	const out: SearchResult[] = [];
	const linkRe = /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snipRe = /<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
	const links = [...html.matchAll(linkRe)].map((m) => ({ url: decodeDdgUrl(m[1]), title: stripTags(m[2]).trim() }));
	const snippets = [...html.matchAll(snipRe)].map((m) => stripTags(m[1]).trim());
	for (let i = 0; i < links.length; i++) {
		if (!links[i].url || links[i].url.startsWith("javascript:")) continue;
		out.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
	}
	return out;
}

/** Parse jina.ai reader markdown output of DDG html results page. */
function parseDuckDuckGoProxy(markdown: string): SearchResult[] {
	const out: SearchResult[] = [];
	const lines = markdown.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const imgMatch = line.match(/^\[!\[Image \d+\]\([^)]+\)\]\(([^)]+)\)/);
		if (!imgMatch) continue;
		const url = decodeDdgUrl(imgMatch[1]);
		if (!url || !/^https?:\/\//.test(url) || url.includes("duckduckgo.com")) continue;
		let title = "";
		let snippet = "";
		for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
			const next = lines[j].trim();
			if (!next || next.startsWith("[![")) break;
			if (!title && next.length > 10) {
				const titleMatch = next.match(/^\[([^\]]{5,})\]/);
				title = stripReaderMarkdown(titleMatch ? titleMatch[1] : next);
			} else if (title && next.length > 20 && !next.startsWith("[")) {
				snippet = stripReaderMarkdown(next);
				break;
			}
		}
		if (!title) title = url.replace(/^https?:\/\//, "").split("/")[0];
		out.push({ title, url, snippet });
	}
	return out;
}

function stripReaderMarkdown(s: string): string {
	return s.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ").trim();
}

function decodeDdgUrl(href: string): string {
	const m = href.match(/uddg=([^&]+)/);
	if (m) {
		try {
			return decodeURIComponent(m[1]);
		} catch {
			return href;
		}
	}
	return href;
}

function stripTags(s: string): string {
	return s
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'");
}

/** Rank results: authoritative TLDs up, content farms down, dedupe by host+path. */
export function rankResults(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	return results
		.filter((r) => {
			const key = r.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((r) => ({ r, score: scoreUrl(r.url) }))
		.sort((a, b) => b.score - a.score)
		.map((s) => s.r);
}

function scoreUrl(url: string): number {
	let score = 0;
	const host = url.replace(/^https?:\/\/([^/]+).*/, "$1").toLowerCase();
	if (/\.gov\b/.test(host)) score += 5;
	if (/\.edu\b|\.ac\.[a-z]{2}$/.test(host)) score += 4;
	if (/\.org\b/.test(host)) score += 2;
	if (/wikipedia\.org/.test(host)) score += 1;
	if (/medium\.com|substack\.com|quora\.com|reddit\.com/.test(host)) score -= 2;
	return score;
}
