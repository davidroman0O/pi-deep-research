// src/llm.ts — the harness's engine.
//
// Thin wrapper over pi-ai's `complete()` that resolves auth from the live
// ModelRegistry (the user's own configured providers/keys/accounts) and returns
// structured JSON. Every phase of the research loop goes through here.
//
// Why not createAgentSession per call? Those carry tool-calling and an event
// bus — overhead we don't want for one-shot structured prompts. `complete()` is
// the right rung: one model call, our abort signal, our auth.

import { complete } from "@earendil-works/pi-ai/compat";
import type { Context, Tool, ToolCall } from "@earendil-works/pi-ai";

// Model is generic over its API; we keep it opaque here so the handle works
// with any provider without leaking a type parameter through every call site.
type AnyModel = import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;

/** Resolved provider auth (the shape ctx.modelRegistry.getProviderAuth returns). */
export interface ProviderAuth {
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** Minimal handle to the live registry — what we actually use from ctx.modelRegistry. */
export interface ModelHandle {
	/** Currently active model in the session (the user's pick). */
	model: AnyModel;
	/** Resolve provider auth by provider id (keys live in auth.json, not env). */
	getAuth: (providerId: string) => Promise<ProviderAuth | null>;
}

export interface LlmOptions {
	/** Caller's abort signal — research runs are long and interruptible. */
	signal?: AbortSignal;
	/** Override model for this call (e.g. a cheaper model for extraction). */
	model?: AnyModel;
	/** Lower temperature for factual extraction, higher for query diversification. */
	temperature?: number;
	/** Soft cap on output tokens. */
	maxTokens?: number;
	/** Max wall-clock for the call. */
	timeoutMs?: number;
}

/*
 * Run a single model call with a native tool definition and return the tool's
 * structured arguments — schema-enforced by the provider (constrained sampling,
 * strict: "require"), NOT parsed out of prose. Falls back to extractJson only
 * when a provider returns text instead of a tool call.
 */
export async function llmJson<T = unknown>(
	handle: ModelHandle,
	tool: Tool,
	systemPrompt: string,
	userPrompt: string,
	opts: LlmOptions = {},
	progress?: (delta: string) => void,
): Promise<T> {
	const model = opts.model ?? handle.model;
	const auth = await handle.getAuth(model.provider);

	// Enforce provider-side schema compliance where supported; "prefer" degrades
	// gracefully on providers without constrained sampling (they still honor the
	// tool schema — it's in the request either way).
	tool.constrainedSampling = { type: "json_schema", strict: "prefer" };

	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		tools: [tool],
	};

	// Force the tool call. Without this, some providers answer in prose and the
	// structured phase contract breaks. Anthropic/Google/Mistral use "any";
	// OpenAI chat-completions uses "required".
	const api = model.api as string;
	const toolChoice =
		api === "openai-completions" ? "required" : "any";

	const baseOptions = {
		apiKey: auth?.apiKey,
		headers: auth?.headers,
		env: auth?.env,
		signal: opts.signal,
		temperature: opts.temperature,
		maxTokens: opts.maxTokens,
		timeoutMs: opts.timeoutMs,
		maxRetries: 2,
	};

	let msg: Awaited<ReturnType<typeof complete>>;
	try {
		msg = await complete(model, context, { ...baseOptions, toolChoice } as Record<string, unknown>);
	} catch (err) {
		if (!/tool_choice|incompatible with thinking/i.test(String(err))) throw err;
		msg = await complete(model, context, { ...baseOptions, toolChoice: "auto" } as Record<string, unknown>);
	}
	// Providers report some failures in-band (stopReason=error), not as throws.
	// Thinking-enabled endpoints reject forced tool_choice this way — retry once
	// with "auto" (still tool-call semantics, just unforced).
	if (msg.stopReason === "error") {
		const errText = (msg as { errorMessage?: string }).errorMessage ?? "";
		if (/tool_choice|incompatible with thinking/i.test(errText)) {
			msg = await complete(model, context, { ...baseOptions, toolChoice: "auto" } as Record<string, unknown>);
		}
	}

	const toolCall = (msg.content ?? []).find((b): b is ToolCall => typeof b === "object" && b.type === "toolCall");
	if (!toolCall) {
		throw new Error(
			`Provider ${model.provider} returned no tool call for '${tool.name}' (stopReason=${msg.stopReason}). The tool schema is the contract — nothing to parse.`,
		);
	}
	return toolCall.arguments as T;
}

/** Run a single model call and return raw text (for the final report). */
export async function llmText(
	handle: ModelHandle,
	systemPrompt: string,
	userPrompt: string,
	opts: LlmOptions = {},
): Promise<string> {
	const model = opts.model ?? handle.model;
	const auth = await handle.getAuth(model.provider);
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
	};
	const msg = await complete(model, context, {
		apiKey: auth?.apiKey,
		headers: auth?.headers,
		env: auth?.env,
		signal: opts.signal,
		temperature: opts.temperature,
		maxTokens: opts.maxTokens,
		timeoutMs: opts.timeoutMs,
		maxRetries: 2,
	});
	return (msg.content ?? [])
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b.type === "text")
		.map((b) => b.text)
		.join("\n");
}
