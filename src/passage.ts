// src/passage.ts — relevant-passage selection (§8) + Tier-1 passage index.
//
// The reference design never feeds whole documents to the extractor: it
// segments, ranks passages against the task question, and extracts only from
// the top passages under a token budget. This module is that pipeline:
//   chunk (structural, heading-aware) → BM25 rank → budgeted selection.
//
// No embeddings — BM25 over tokens is the cheap, deterministic rung that works.

export interface Passage {
	id: string;
	section: string; // nearest markdown heading above the chunk
	text: string;
	start: number; // char offset in source document
	end: number;
}

const CHUNK_SIZE = 900; // chars, ~225 tokens
const CHUNK_OVERLAP = 150;

/** Segment a markdown/plain document into overlapping, heading-tagged passages. */
export function chunkDocument(text: string): Passage[] {
	if (text.length <= CHUNK_SIZE) {
		return [{ id: "p1", section: "", text, start: 0, end: text.length }];
	}
	// heading offsets for section tagging
	const headings: Array<{ pos: number; title: string }> = [];
	for (const m of text.matchAll(/^#{1,4}\s+(.+)$/gm)) {
		headings.push({ pos: m.index ?? 0, title: m[1].trim() });
	}
	const sectionAt = (pos: number): string => {
		let cur = "";
		for (const h of headings) {
			if (h.pos <= pos) cur = h.title;
			else break;
		}
		return cur;
	};

	const passages: Passage[] = [];
	let pos = 0;
	let n = 0;
	while (pos < text.length) {
		let end = Math.min(pos + CHUNK_SIZE, text.length);
		// prefer to break at a paragraph or sentence boundary
		if (end < text.length) {
			const para = text.lastIndexOf("\n\n", end);
			const sent = text.lastIndexOf(". ", end);
			const cut = Math.max(para, sent);
			if (cut > pos + CHUNK_SIZE / 2) end = cut + 1;
		}
		n++;
		passages.push({
			id: `p${n}`,
			section: sectionAt(pos),
			text: text.slice(pos, end),
			start: pos,
			end,
		});
		if (end >= text.length) break;
		pos = end - CHUNK_OVERLAP;
	}
	return passages;
}

/** BM25 over tokens — the standard ranking function for passage retrieval. */
export function rankPassages(query: string, passages: Passage[], k1 = 1.2, b = 0.75): Array<{ passage: Passage; score: number }> {
	const queryTerms = tokenize(query);
	if (queryTerms.length === 0) return passages.map((p) => ({ passage: p, score: 0 }));

	const docs = passages.map((p) => tokenize(p.section + " " + p.text));
	const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);

	// document frequency per term
	const df = new Map<string, number>();
	for (const d of docs) {
		const seen = new Set(d);
		for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const N = docs.length;
	const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

	const scored = passages.map((p, i) => {
		const d = docs[i];
		const tf = new Map<string, number>();
		for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
		let score = 0;
		for (const t of queryTerms) {
			const f = tf.get(t) ?? 0;
			if (f === 0) continue;
			score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLen)));
		}
		return { passage: p, score };
	});
	scored.sort((a, z) => z.score - a.score);
	return scored;
}

/**
 * Budgeted selection (§13.2): pick the highest-scoring passages that fit the
 * char budget. Always includes the first chunk (title/abstract context) even
 * if it scores low — intro sections carry definitions.
 */
export function selectPassages(query: string, passages: Passage[], charBudget: number): Passage[] {
	const ranked = rankPassages(query, passages);
	const selected: Passage[] = [];
	let used = 0;

	// intro passage first
	const first = passages[0];
	if (first && first.text.length <= charBudget) {
		selected.push(first);
		used += first.text.length;
	}
	for (const { passage, score } of ranked) {
		if (score <= 0) break;
		if (selected.includes(passage)) continue;
		if (used + passage.text.length > charBudget) continue;
		selected.push(passage);
		used += passage.text.length;
	}
	// restore document order so the extractor sees coherent flow
	selected.sort((a, b) => a.start - b.start);
	return selected;
}

/** Assemble the selected passages into extractor input, section-tagged. */
export function assembleContext(passages: Passage[]): string {
	return passages
		.map((p) => (p.section ? `<passage section="${escapeXml(p.section)}">\n${p.text}\n</passage>` : `<passage>\n${p.text}\n</passage>`))
		.join("\n");
}

function tokenize(s: string): string[] {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 2 && !STOP.has(t));
}

const STOP = new Set([
	"the", "and", "for", "are", "but", "not", "you", "all", "can", "has", "was", "one",
	"our", "out", "his", "her", "its", "per", "from", "with", "this", "that", "have",
	"what", "which", "their", "they", "been", "into", "than", "then", "them",
]);

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
