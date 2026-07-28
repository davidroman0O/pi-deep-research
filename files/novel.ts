// src/novel.ts — duplicate detection + information novelty (§17).
//
// Without this the agent may read fifty articles derived from one press release.
// Three layers, cheapest first:
//   1. canonical URL normalization (strip tracking params, lowercase host)
//   2. content hash (exact dup)
//   3. SimHash-style near-duplicate fingerprint (catches minor edits / mirrors)

/** Canonicalize a URL for dedup: lowercase host, drop fragment, strip tracking params. */
export function canonicalUrl(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return raw;
	}
	u.hash = "";
	u.hostname = u.hostname.toLowerCase();
	const TRACKING = new Set([
		"utm_source",
		"utm_medium",
		"utm_campaign",
		"utm_term",
		"utm_content",
		"gclid",
		"fbclid",
		"ref",
		"ref_src",
		"_ga",
		"mc_cid",
		"mc_eid",
		"igshid",
		"si",
	]);
	const keep: string[] = [];
	u.searchParams.forEach((v, k) => {
		if (!TRACKING.has(k.toLowerCase())) keep.push(`${k}=${v}`);
	});
	keep.sort();
	u.search = keep.length ? "?" + keep.join("&") : "";
	// drop trailing slash except for root
	let s = u.toString();
	if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
	return s;
}

/** Exact-match content hash (djb2). */
export function contentHash(text: string): string {
	const norm = text.replace(/\s+/g, " ").trim().toLowerCase();
	let h = 5381;
	for (let i = 0; i < norm.length; i++) h = (h * 33) ^ norm.charCodeAt(i);
	return (h >>> 0).toString(16);
}

/**
 * SimHash: a locality-sensitive fingerprint. Near-duplicates produce near-identical
 * 64-bit hashes, so Hamming distance detects them cheaply without embeddings.
 * Tokenizes on word boundaries, hashes each token, weighs by frequency.
 */
export function simhash(text: string, bits = 64): bigint {
	const tokens = text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1);
	if (tokens.length === 0) return 0n;
	const freq = new Map<string, number>();
	for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

	const v = new Int32Array(bits);
	for (const [tok, weight] of freq) {
		const h = fnv1a(tok);
		for (let i = 0; i < bits; i++) {
			const bit = (h >> BigInt(i)) & 1n;
			v[i] += bit === 1n ? weight : -weight;
		}
	}
	let out = 0n;
	for (let i = 0; i < bits; i++) if (v[i] > 0) out |= 1n << BigInt(i);
	return out;
}

function fnv1a(s: string): bigint {
	let h = 0xcbf29ce484222325n;
	for (let i = 0; i < s.length; i++) {
		h ^= BigInt(s.charCodeAt(i));
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h;
}

/** Hamming distance between two bigint fingerprints. */
export function hamming(a: bigint, b: bigint): number {
	let x = a ^ b;
	let n = 0;
	while (x) {
		n += Number(x & 1n);
		x >>= 1n;
	}
	return n;
}

export interface DuplicateVerdict {
	isDuplicate: boolean;
	reason: "canonical-url" | "content-hash" | "near-duplicate" | null;
	matchedUrl?: string;
	distance?: number;
}

/** Compare a candidate against known documents. */
export function checkDuplicate(
	candUrl: string,
	candText: string,
	known: Array<{ url: string; hash: string; fingerprint: bigint }>,
	nearDupThreshold = 6,
): DuplicateVerdict {
	const canon = canonicalUrl(candUrl);
	const candHash = contentHash(candText);
	const candFp = simhash(candText);

	for (const k of known) {
		if (canonicalUrl(k.url) === canon) return { isDuplicate: true, reason: "canonical-url", matchedUrl: k.url };
		if (k.hash === candHash) return { isDuplicate: true, reason: "content-hash", matchedUrl: k.url };
	}
	// near-dup via SimHash
	let best: { url: string; dist: number } | null = null;
	for (const k of known) {
		const d = hamming(candFp, k.fingerprint);
		if (!best || d < best.dist) best = { url: k.url, dist: d };
	}
	if (best && best.dist <= nearDupThreshold) {
		return { isDuplicate: true, reason: "near-duplicate", matchedUrl: best.url, distance: best.dist };
	}
	return { isDuplicate: false, reason: null };
}

/**
 * Information novelty (§17.2): how much NEW factual content a source adds vs
 * what's already known. Token-set overlap is a cheap proxy for embedding cosine.
 * Returns 0..1; <0.15 means the source adds little new information.
 */
export function novelty(candidateText: string, knownTexts: string[]): number {
	const cand = tokenSet(candidateText);
	if (cand.size === 0) return 0;
	let maxOverlap = 0;
	for (const k of knownTexts) {
		const ks = tokenSet(k);
		if (ks.size === 0) continue;
		let shared = 0;
		for (const t of cand) if (ks.has(t)) shared++;
		const overlap = shared / cand.size;
		if (overlap > maxOverlap) maxOverlap = overlap;
	}
	return 1 - maxOverlap;
}

function tokenSet(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 2),
	);
}
