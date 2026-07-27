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

	// Robust retry: any thrown or in-band stopReason=error is retried with
	// backoff. The thinking/tool_choice incompatibility degrades toolChoice to
	// "auto" on retry (still tool-call semantics, just unforced). Transient
	// flakes (529/timeout/server hiccup) get a plain retry. A long research run
	// spans dozens of calls — one transient must not kill the whole pipeline.
	const MAX_CALL_ATTEMPTS = 4;
	let msg: Awaited<ReturnType<typeof complete>> | undefined;
	let lastErr = "";
	for (let attempt = 0; attempt < MAX_CALL_ATTEMPTS; attempt++) {
		checkAbort(opts.signal);
		const choice = /tool_choice|incompatible with thinking/i.test(lastErr) ? "auto" : toolChoice;
		try {
			msg = await complete(model, context, { ...baseOptions, toolChoice: choice } as Record<string, unknown>);
		} catch (err) {
			lastErr = String(err);
			await backoff(attempt, opts.signal);
			continue;
		}
		if (msg.stopReason !== "error") break;
		lastErr = (msg as { errorMessage?: string }).errorMessage ?? "";
		await backoff(attempt, opts.signal);
	}
	if (!msg) throw new Error(`Provider ${model.provider} failed after ${MAX_CALL_ATTEMPTS} attempts: ${lastErr}`);

	const toolCall = (msg.content ?? []).find((b): b is ToolCall => typeof b === "object" && b.type === "toolCall");
	if (!toolCall) {
		throw new Error(
			`Provider ${model.provider} returned no tool call for '${tool.name}' (stopReason=${msg.stopReason}${lastErr ? `, ${lastErr.slice(0, 120)}` : ""}). The tool schema is the contract — nothing to parse.`,
		);
	}
	return toolCall.arguments as T;
}

function checkAbort(signal?: AbortSignal) {
	if (signal?.aborted) {
		const err = new Error("aborted") as Error & { aborted?: true };
		err.aborted = true;
		throw err;
	}
}

async function backoff(attempt: number, signal?: AbortSignal) {
	const ms = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
	await new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
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
	// Same retry discipline as llmJson: a transient stopReason=error must not
	// kill a multi-minute run.
	let msg: Awaited<ReturnType<typeof complete>> | undefined;
	let lastErr = "";
	for (let attempt = 0; attempt < 4; attempt++) {
		checkAbort(opts.signal);
		try {
			msg = await complete(model, context, {
				apiKey: auth?.apiKey,
				headers: auth?.headers,
				env: auth?.env,
				signal: opts.signal,
				temperature: opts.temperature,
				maxTokens: opts.maxTokens,
				timeoutMs: opts.timeoutMs,
				maxRetries: 2,
			});
		} catch (err) {
			lastErr = String(err);
			await backoff(attempt, opts.signal);
			continue;
		}
		if (msg.stopReason !== "error") break;
		lastErr = (msg as { errorMessage?: string }).errorMessage ?? "";
		await backoff(attempt, opts.signal);
	}
	if (!msg) throw new Error(`Provider ${model.provider} failed after 4 attempts: ${lastErr}`);
	return (msg.content ?? [])
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b.type === "text")
		.map((b) => b.text)
		.join("\n");
}
