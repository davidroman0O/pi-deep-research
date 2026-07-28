// src/ingest.ts — fetch + parse external content into normalized documents.
//
// Two backends, config-selected (src/config.ts):
//   native      — direct fetch; HTML→Readability→Turndown, PDF→pdf-parse, text raw
//   scrapegraph — ScrapeGraphAI /api/scrape (markdown reader mode); handles JS
//                 rendering and bot-wall cases the native path cannot
//
// EVERY document passes through the trust layer: injection assessment, secret
// redaction, and an untrusted-XML envelope is available for prompt assembly
// (trust.ts). The model never sees raw web bytes without the data-plane wrapper.

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import pdfParse from "pdf-parse";
import { assessContent, redactSecrets, type TrustTag } from "./trust.ts";
import { getConfig, resolveScrapeBackend, resolveKey, type ScrapeBackendId } from "./config.ts";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "nav", "footer", "aside"]);

export interface Document {
	url: string;
	title: string;
	contentType: string;
	kind: "html" | "pdf" | "text";
	text: string; // markdown for html, plain for pdf/text
	chars: number;
	fetchedAt: string;
	backend: ScrapeBackendId;
	trust: TrustTag;
	date?: string;
}

export interface IngestOptions {
	maxChars?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	backend?: ScrapeBackendId; // override config
}

/** Fetch + parse a URL. Trust assessment is always applied. Throws on failure. */
export async function ingestUrl(url: string, opts: IngestOptions = {}): Promise<Document> {
	const cfg = await getConfig();
	let backend = opts.backend ?? resolveScrapeBackend(cfg);
	const maxChars = opts.maxChars ?? 20_000;

	// ScrapeGraph's markdown reader cannot process PDFs (502 content_process_failed).
	// Route by content type: PDFs always go native (pdf-parse).
	const cleanUrl = sanitizeUrl(url);
	if (looksLikePdf(cleanUrl)) backend = "native";

	let doc: Document;
	if (backend === "scrapegraph") {
		const key = resolveKey(cfg, "scrapegraph");
		if (!key) throw new Error("ScrapeGraph backend selected but no key configured");
		try {
			doc = await ingestViaScrapeGraph(cleanUrl, key, opts);
		} catch (err) {
			// Cross-backend retry: the two backends have disjoint failure modes
			// (bot walls vs PDFs). A serious research tool tries both before
			// declaring a source unreadable.
			doc = await ingestNative(cleanUrl, opts);
		}
	} else {
		doc = await ingestNative(cleanUrl, opts);
	}

	// trust layer — always
	const tag = assessContent(doc.text);
	const redacted = redactSecrets(doc.text);
	doc = { ...doc, text: redacted.slice(0, maxChars), trust: tag, backend };
	doc.chars = doc.text.length;
	return doc;
}

/** Strip zero-width unicode that leaks into URLs from copy-paste / Exa results. */
function sanitizeUrl(url: string): string {
	return url.replace(/[​‌‍﻿]/g, "");
}

function looksLikePdf(url: string): boolean {
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return url.toLowerCase().includes(".pdf");
	}
}

// ── native backend ───────────────────────────────────────────────────────
async function ingestNative(url: string, opts: IngestOptions): Promise<Document> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		const res = await fetch(url, {
			headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,text/*,*/*;q=0.1" },
			signal: controller.signal,
			redirect: "follow",
		});
		if (!res.ok) throw new Error(`fetch ${res.status}`);
		const contentType = (res.headers.get("content-type") ?? "application/octet-stream").toLowerCase();
		const buf = Buffer.from(await res.arrayBuffer());

		if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
			const data = await pdfParse(buf);
			const text = (data.text ?? "").replace(//g, "").trim();
			return baseDoc(url, data.info?.Title || url.split("/").pop() || url, contentType, "pdf", text);
		}
		return parseHtmlOrText(url, buf.toString("utf8"), contentType);
	} finally {
		clearTimeout(timer);
	}
}

function parseHtmlOrText(url: string, raw: string, contentType: string): Document {
	const looksHtml =
		/^\s*<(?:!doctype html|html|head|body|h1|p|div|svg)\b/i.test(raw) || contentType.includes("html");
	if (!looksHtml) {
		return baseDoc(url, url.split("/").pop() ?? url, contentType, "text", raw);
	}

	const dom = new JSDOM(raw, { url });
	let title = dom.window.document.title ?? url;
	let bodyHtml = dom.window.document.body?.innerHTML ?? raw;
	try {
		const reader = new Readability(dom.window.document.cloneNode(true) as globalThis.Document);
		const article = reader.parse();
		if (article?.content) {
			bodyHtml = article.content;
			if (article.title) title = article.title;
		}
	} catch {
		/* Readability failed — keep the raw body, extraction decides usefulness */
	}
	const md = turndown.turndown(bodyHtml);
	const metaDate = extractMetaDate(dom);
	return baseDoc(url, title, contentType, "html", md, metaDate);
}

// ── scrapegraph backend ──────────────────────────────────────────────────
async function ingestViaScrapeGraph(url: string, key: string, opts: IngestOptions): Promise<Document> {
	const timeoutMs = opts.timeoutMs ?? 45_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		const res = await fetch("https://v2-api.scrapegraphai.com/api/scrape", {
			method: "POST",
			headers: { "SGAI-APIKEY": key, "Content-Type": "application/json" },
			body: JSON.stringify({
				url,
				formats: [{ type: "markdown", mode: "reader" }],
			}),
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`ScrapeGraph ${res.status}: ${body.slice(0, 200)}`);
		}
		const data = (await res.json()) as {
			id: string;
			results?: { markdown?: { data?: string[] }; screenshot?: unknown };
			metadata?: { contentType?: string; title?: string };
		};
		const md = data.results?.markdown?.data?.[0];
		if (!md || md.trim().length === 0) throw new Error("ScrapeGraph returned no markdown");
		const title = data.metadata?.title || md.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 120) || url;
		return baseDoc(url, title, data.metadata?.contentType ?? "text/html", "html", md);
	} finally {
		clearTimeout(timer);
	}
}

// ── helpers ──────────────────────────────────────────────────────────────
function baseDoc(url: string, title: string, contentType: string, kind: Document["kind"], text: string, date?: string): Document {
	return {
		url,
		title,
		contentType,
		kind,
		text,
		chars: text.length,
		fetchedAt: new Date().toISOString(),
		backend: "native", // overwritten by ingestUrl
		trust: { level: "untrusted", injectionRisk: 0, flags: [] }, // overwritten by ingestUrl
		date,
	};
}

function extractMetaDate(dom: JSDOM): string | undefined {
	const doc = dom.window.document;
	for (const sel of [
		'meta[property="article:published_time"]',
		'meta[name="date"]',
		'meta[name="publish-date"]',
		'meta[name="DC.date"]',
		"time[datetime]",
	]) {
		const el = doc.querySelector(sel);
		const v = el?.getAttribute("content") ?? el?.getAttribute("datetime");
		if (v && /^\d{4}/.test(v)) return v.slice(0, 10);
	}
	return undefined;
}
