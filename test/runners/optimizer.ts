// test/runners/optimizer.ts — run the code-optimizer agent via a real Pi session.
//
// Launches a fresh Pi session with a specific model (from config optimizerModel,
// or --model override) and runs the optimizer prompt. Returns structured JSON
// {diff, rationale, files_read} on stdout.
//
// This mirrors candidate.ts: it uses the SDK directly (createAgentSession with a
// chosen model), so the model does NOT need to be the active session model and is
// NOT subject to pi-extensible-workflows' launch-time model registry validation.
//
// Usage:  OPTIMIZER_PROMPT_FILE=/tmp/opt-prompt.txt bun test/runners/optimizer.ts [--model provider/model-id]

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	getAgentDir,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../../src/config.ts";

const PROMPT_FILE = process.env.OPTIMIZER_PROMPT_FILE;
if (!PROMPT_FILE) {
	console.error("OPTIMIZER_PROMPT_FILE env var required");
	process.exit(2);
}

// Resolve model: CLI arg --model beats config optimizerModel, else candidateModel.
const argModel = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1];
const cfg = await getConfig();
const targetModel = argModel ?? cfg.optimizerModel ?? cfg.candidateModel ?? "";

const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();
const resolve = (ref: string) =>
	available.find((m) => `${m.provider}/${m.id}` === ref) ??
	available.find((m) => m.provider === ref.split("/")[0] && m.id.startsWith(ref.split("/")[1] ?? ""));

const model = targetModel ? resolve(targetModel) ?? available[0] : available[0];
if (!model) {
	console.error("No model available in runtime");
	process.exit(2);
}
console.error(`optimizer model: ${model.provider}/${model.id}`);

// The session must run with the repo root as cwd so the optimizer agent can
// actually read src/ and produce diffs that apply. The workflow invokes this
// runner from the repo root, so process.cwd() is the repo. (candidate.ts uses
// a temp sandbox, but the optimizer needs real source access to generate
// valid, applying patches.)
const cwd = process.cwd();
const { session } = await createAgentSession({
	cwd,
	modelRuntime: runtime,
	sessionManager: SessionManager.inMemory(cwd),
	model,
});

const prompt = await readFile(PROMPT_FILE, "utf8");

// Collect final assistant text.
let lastAssistantText = "";
const events: AgentSessionEvent[] = [];
const unsub = session.subscribe((e) => {
	events.push(e);
	if (
		e.type === "message_update" &&
		(e as { assistantMessageEvent?: { type: string; text?: string; delta?: string } }).assistantMessageEvent
	) {
		const ame = (e as any).assistantMessageEvent;
		if (ame.type === "text_delta" && typeof ame.delta === "string") lastAssistantText += ame.delta;
	}
});

await session.prompt(prompt);
unsub();

// Prefer final assistant message text; fall back to accumulated deltas.
let text = "";
	try {
	const msgs = (session as any).messages as any[];
	const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && typeof m.content === "string");
	if (lastAssistant) text = lastAssistant.content;
} catch { /* ignore */ }
if (!text.trim()) text = lastAssistantText;

// Extract JSON from the response (fenced or bare).
function extractJson(raw: string): any {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced ? fenced[1] : raw;
	try {
		return JSON.parse(candidate);
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(candidate.slice(start, end + 1));
			} catch {
				return null;
			}
		}
		return null;
	}
}

const parsed = extractJson(text);
const out = parsed ?? {
	diff: text,
	rationale: "",
	files_read: [],
};

// Write the diff to __opt.patch in the current working directory so the
// workflow can apply it directly with git apply (no shell heredoc, which
// blocks on stdin in the workflow shell() helper).
const diffText = (out.diff ?? "").trim();
if (diffText) {
	try {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(process.cwd(), "__opt.patch"), diffText + "\n", "utf8");
	} catch (e) {
		console.error("failed to write __opt.patch: " + (e as Error).message);
	}
}

console.log(JSON.stringify({ diff: out.diff ?? "", rationale: out.rationale ?? "", files_read: out.files_read ?? [] }));
process.exit(0);
