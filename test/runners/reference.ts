// test/runners/reference.ts — DRH reference manager (cached + TTL).
//
// Manages the ChatGPT Deep Research Heavy reference report per topic.
// Checks TTL-based staleness (§3.2), loads cached report, or instructs
// the caller to generate one via gpt_chat if missing/stale.
//
// The actual gpt_chat call happens in the caller's context (Pi session
// or manual) — this module handles cache logic only.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { isReferenceStale, invalidateReference } from "../lib/artifacts.ts";

export interface ReferenceResult {
	report: string;
	cached: boolean;
	regenerate: boolean; // true if caller needs to run DRH
	instructions?: string; // how to generate if missing
}

/**
// Get the DRH reference report for a topic.
 *
// - If cached and fresh → return it.
// - If cached but stale (TTL expired) → invalidate, return regenerate=true.
// - If not cached → return regenerate=true with instructions.
 *
// The caller is responsible for actually running gpt_chat deep_research_heavy
// and saving the result via saveReference().
 */
export async function getReference(
	topicDir: string,
	ttlDays: number,
	topic: string,
): Promise<ReferenceResult> {
	const reportPath = join(topicDir, "drh_report.md");

	// Not cached at all
	if (!existsSync(reportPath)) {
		return {
			report: "",
			cached: false,
			regenerate: true,
			instructions: generateInstructions(topic, topicDir),
		};
	}

	// Cached — check TTL
	const stale = await isReferenceStale(topicDir, ttlDays);
	if (stale) {
		console.log(`  ⚠ DRH reference expired (TTL ${ttlDays} days), invalidating cache`);
		await invalidateReference(topicDir);
		return {
			report: "",
			cached: false,
			regenerate: true,
			instructions: generateInstructions(topic, topicDir),
		};
	}

	// Fresh cache
	const report = await readFile(reportPath, "utf8");
	console.log(`  ✓ cached DRH reference: ${report.split(/\s+/).length} words`);
	return { report, cached: true, regenerate: false };
}

/**
// Save a DRH reference report (called after gpt_chat produces one).
 */
export async function saveReference(
	topicDir: string,
	report: string,
	conversationId?: string,
	quotaUsed?: number,
): Promise<void> {
	await writeFile(join(topicDir, "drh_report.md"), report, "utf8");
	await writeFile(
		join(topicDir, "drh_meta.json"),
		JSON.stringify({
			timestamp: new Date().toISOString(),
			conversation_id: conversationId,
			quota_used: quotaUsed,
		}, null, 2),
		"utf8",
	);
	console.log(`  ✓ saved DRH reference (${report.split(/\s+/).length} words)`);
}

function generateInstructions(topic: string, topicDir: string): string {
	return [
		`No cached DRH reference for this topic.`,
		`Run gpt_chat deep_research_heavy on:`,
		`  "${topic}"`,
		``,
		`Then save the report to:`,
		`  ${join(topicDir, "drh_report.md")}`,
		``,
		`Or use the runner programmatically:`,
		`  const result = await gptChat({ prompt: topic, chat_type: "deep_research_heavy" });`,
		`  await saveReference(topicDir, result.text, result.conversation_id);`,
	].join("\n");
}
