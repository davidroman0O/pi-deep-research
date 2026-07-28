// src/parallel.ts — bounded concurrency for the research pipeline.
//
// §26's multi-agent variant: each source gets its own extractor invocation,
// each its own summarizer — many small model calls running concurrently, not
// one giant sequential chain. The bound matters: too high and providers rate
// limit; too low and the run crawls.

/** Run fn over items with at most `concurrency` in flight. Abort-aware: rejects fast on signal. */
export async function runParallel<T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	concurrency = 3,
	signal?: AbortSignal,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
	const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
	let next = 0;

	async function worker() {
		while (true) {
			if (signal?.aborted) return;
			const i = next++;
			if (i >= items.length) return;
			try {
				const value = await fn(items[i], i);
				results[i] = { ok: true, value };
			} catch (error) {
				results[i] = { ok: false, error };
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

/** Unwrap runParallel results, dropping failures (already logged by caller's fn). */
export function successes<R>(results: Array<{ ok: true; value: R } | { ok: false; error: unknown }>): R[] {
	return results.filter((r): r is { ok: true; value: R } => r.ok).map((r) => r.value);
}
