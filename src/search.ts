// src/search.ts — search backends.
//
// Four providers behind one interface. Selection is config-driven
// (src/config.ts): exa (neural + deep research), tavily, scrapegraph (search +
// inline content), ddg (no-key fallback). No mocks, no fake providers — every
// backend hits its real API.

import Exa from "exa-js";
import { getConfig, resolveEnabledSearchBackends, resolveKey, type SearchBackendId } from "./config.ts";
import { canonicalUrl } from "./novel.ts";

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
	return providers.length === 1 ? providers[0] : new MultiSearchProvider(providers);
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

/** DuckDuckGo Lite — no key, default. */
export class DuckDuckGoProvider implements SearchProvider {
	name: SearchBackendId = "ddg";
	async search(query: string, signal?: AbortSignal, limit = 8): Promise<SearchResult[]> {
		const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
		const res = await fetch(url, { headers: { "User-Agent": UA }, signal });
		if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
		const html = await res.text();
		return parseDuckDuckGoLite(html).slice(0, limit);
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
