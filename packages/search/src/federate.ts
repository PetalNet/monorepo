// The federation core: fan a query to every provider IN PARALLEL, isolate
// failures, then merge → dedupe → rank into one provenance-tagged answer.
//
// Design guarantees:
//  - PARALLEL: every provider is queried concurrently (Promise.allSettled).
//  - ISOLATED: one slow or throwing provider can never sink the whole query;
//    it lands in `errors` and the rest still return.
//  - BOUNDED: each provider gets its own timeout (via AbortController). The
//    caller's `signal` is chained so an outer cancel aborts all providers.
//  - DETERMINISTIC: same inputs → same ordering (stable tiebreaks in `rank`).

import { defaultRanker, rank, type RankInput, type Ranker } from "./rank.ts";
import { ProviderRegistry } from "./registry.ts";
import type {
	Action,
	Provider,
	ProviderError,
	QueryOptions,
	RankedResult,
	Result,
	SearchResponse,
} from "./types.ts";

/** Options for a single federated {@link search} call. */
export interface SearchOptions {
	/**
	 * Providers to query. Accepts a {@link ProviderRegistry} or a plain array. Order matters: it is
	 * the stable tiebreak in ranking and the order of the `providers` field in the response.
	 */
	readonly providers: ProviderRegistry | readonly Provider[];
	/** Per-provider deadline in ms before it's aborted and counted as a timeout. Default 5000. */
	readonly perProviderTimeoutMs?: number;
	/** Final cap on returned results after ranking. Default 50. */
	readonly limit?: number;
	/** Pluggable ranker. Defaults to {@link defaultRanker}. */
	readonly ranker?: Ranker;
	/** Forwarded to each provider's `query`. The core adds a per-provider `signal`. */
	readonly query?: Omit<QueryOptions, "signal">;
	/** Outer abort signal; aborting it cancels every in-flight provider. */
	readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 50;

/**
 * Run a federated search.
 *
 * Empty/whitespace queries short-circuit to an empty response (no provider is called) — there's
 * nothing to search for and providers shouldn't have to each guard against it.
 */
export async function search(q: string, options: SearchOptions): Promise<SearchResponse> {
	const providers =
		options.providers instanceof ProviderRegistry
			? options.providers.list()
			: [...options.providers];
	const ranker = options.ranker ?? defaultRanker();
	const limit = options.limit ?? DEFAULT_LIMIT;
	const timeoutMs = options.perProviderTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	if (q.trim() === "" || providers.length === 0) {
		return { results: [], actions: [], providers: [], errors: [] };
	}

	// Fan out in parallel. Each provider gets its own controller so its timeout
	// (or the outer signal) aborts only its own work.
	const settled = await Promise.allSettled(
		providers.map((provider) => queryWithTimeout(provider, q, options, timeoutMs)),
	);

	const okProviders: string[] = [];
	const errors: ProviderError[] = [];
	const rankInputs: RankInput[] = [];
	const actions: Action[] = [];

	settled.forEach((outcome, providerIndex) => {
		const provider = providers[providerIndex];
		if (provider === undefined) return;
		if (outcome.status === "rejected") {
			errors.push(toProviderError(provider.id, outcome.reason));
			return;
		}
		okProviders.push(provider.id);
		const { results, actions: provActions } = outcome.value;
		for (const result of results) {
			// Stamp provenance defensively in case a provider omitted it.
			const stamped: Result = result.providerId ? result : { ...result, providerId: provider.id };
			rankInputs.push({ result: stamped, provider, providerIndex });
		}
		for (const action of provActions ?? []) {
			actions.push(action.providerId ? action : { ...action, providerId: provider.id });
		}
	});

	const ranked = rank(dedupe(rankInputs), ranker);
	return {
		results: ranked.slice(0, limit),
		actions: sortActions(actions),
		providers: okProviders,
		errors,
	};
}

/** Query one provider, racing it against a per-provider timeout. */
async function queryWithTimeout(
	provider: Provider,
	q: string,
	options: SearchOptions,
	timeoutMs: number,
): Promise<{ results: readonly Result[]; actions?: readonly Action[] }> {
	const controller = new AbortController();
	// Chain the outer signal so an external cancel aborts every provider.
	const onOuterAbort = () => controller.abort(options.signal?.reason);
	if (options.signal) {
		if (options.signal.aborted) controller.abort(options.signal.reason);
		else options.signal.addEventListener("abort", onOuterAbort, { once: true });
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new TimeoutError(provider.id, timeoutMs));
	}, timeoutMs);
	try {
		const queryOpts: QueryOptions = { ...options.query, signal: controller.signal };
		return await provider.query(q, queryOpts);
	} catch (err) {
		// A provider that respects the abort signal will reject with its own
		// error, not our TimeoutError. Re-key it to the real cause: if WE aborted
		// it for the deadline, that's a timeout regardless of what it threw.
		if (timedOut) throw new TimeoutError(provider.id, timeoutMs);
		throw err;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onOuterAbort);
	}
}

/**
 * Dedupe across providers. Two hits collide when they share a `url` (after light normalization) or
 * the same `providerId:id` key. The first-seen wins — and because `rankInputs` are in provider
 * order, the higher-priority provider keeps the result. We dedupe BEFORE ranking so scores aren't
 * wasted on dupes.
 */
function dedupe(inputs: readonly RankInput[]): RankInput[] {
	const seen = new Set<string>();
	const out: RankInput[] = [];
	for (const input of inputs) {
		const { result } = input;
		const urlKey = result.url ? `url:${normalizeUrl(result.url)}` : undefined;
		const idKey = `id:${result.providerId}:${result.id}`;
		if (urlKey && seen.has(urlKey)) continue;
		if (seen.has(idKey)) continue;
		if (urlKey) seen.add(urlKey);
		seen.add(idKey);
		out.push(input);
	}
	return out;
}

/** Lowercase host, drop trailing slash & fragment, ignore protocol. Best-effort. */
function normalizeUrl(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname.replace(/\/+$/, "");
		return `${u.host.toLowerCase()}${path}${u.search}`;
	} catch {
		return url.trim().toLowerCase();
	}
}

function sortActions(actions: readonly Action[]): Action[] {
	return actions.toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Thrown internally when a per-provider timeout fires. */
class TimeoutError extends Error {
	constructor(providerId: string, ms: number) {
		super(`Provider ${providerId} timed out after ${ms}ms`);
		this.name = "TimeoutError";
	}
}

function toProviderError(providerId: string, reason: unknown): ProviderError {
	const isTimeout = reason instanceof TimeoutError;
	return { providerId, reason: isTimeout ? "timeout" : "error", error: reason };
}

// Re-export the ranked result type for ergonomic consumer imports.
export type { RankedResult };
