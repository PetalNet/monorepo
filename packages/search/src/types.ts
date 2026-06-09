// @petalnet/search — the distributed-search protocol.
//
// Search is the cross-platform spine: one query fans out to many PROVIDERS
// (web, notes, calendar, contacts, …), each of which answers the same
// `query()` shape. The federation core (see `federate.ts`) merges, dedupes
// and ranks the per-provider answers into a single provenance-tagged list.
//
// This file is the PROTOCOL: the interfaces every provider and the backend
// agree on. It is intentionally runtime-free (pure types) so it can be shared
// anywhere without pulling in network/IO deps.

/**
 * The kind of thing a result represents. Open-ended on purpose: providers may introduce their own
 * kinds (a `"note"`, a `"contact"`, an `"event"`), and the ranker/UI treat unknown kinds
 * gracefully. The string-literal union documents the kinds we ship today; the `(string & {})` arm
 * keeps it extensible without losing autocomplete on the known members.
 */
export type ResultKind =
	| "web"
	| "note"
	| "contact"
	| "event"
	| "file"
	| "app"
	| "command"
	// Allow arbitrary provider-defined kinds while preserving literal hints.
	| (string & {});

/** A JSON-serializable value, for provider-specific `raw` payloads. */
export type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json };

/**
 * A single search hit, normalized to a common shape regardless of which provider produced it.
 *
 * Scoring contract: `score` is the provider's own confidence/relevance in the range [0, 1] where
 * higher is better. The provider does NOT need to know about other providers — cross-provider
 * normalization and weighting happen in the ranker. If a provider can only express an ordinal rank,
 * it should map it into [0, 1] (e.g. `1 - index / total`).
 */
export interface Result {
	/**
	 * Stable identifier for this hit WITHIN its provider. Combined with `providerId` it forms a
	 * globally-unique key. Used for dedupe and for the UI to address a specific result.
	 */
	readonly id: string;
	/** Which provider produced this result. Set by the backend if a provider omits it. */
	readonly providerId: string;
	/** Primary display line. */
	readonly title: string;
	/** Optional secondary display line (snippet, path, sender, …). */
	readonly subtitle?: string;
	/** Canonical link to the underlying thing, if one exists. */
	readonly url?: string;
	/** Provider-local relevance in [0, 1]; higher is better. */
	readonly score: number;
	/** What this result is. See {@link ResultKind}. */
	readonly kind: ResultKind;
	/**
	 * A point-in-time associated with the result (ms since epoch), if known. The default ranker uses
	 * this for a mild recency boost.
	 */
	readonly timestamp?: number;
	/** Untouched provider payload, for consumers that need the original shape. */
	readonly raw?: Json;
}

/**
 * A `Result` after federation: identical to {@link Result} but annotated with the final
 * cross-provider score the ranker assigned. Kept separate so a provider can never be asked to
 * populate `rankScore` itself.
 */
export interface RankedResult extends Result {
	/** Final cross-provider score the ranker assigned; higher is better. */
	readonly rankScore: number;
}

/**
 * An invokable command surfaced alongside results — e.g. "Create a note titled <q>", "Open
 * calendar", "Search the web for <q>". Actions are how a provider offers a _next step_ rather than
 * a passive hit. Invocation is left to the host (the protocol only describes the action); `invoke`
 * is optional so actions can also be pure intents the UI dispatches itself.
 */
export interface Action {
	/** Stable id within the provider. */
	readonly id: string;
	/** Provider that offered the action. Set by the backend if omitted. */
	readonly providerId: string;
	/** Display label, e.g. "Search the web". */
	readonly title: string;
	/** Optional secondary label. */
	readonly subtitle?: string;
	/** Optional grouping/sorting hint, [0, 1]; higher sorts first. */
	readonly score?: number;
	/**
	 * Perform the action. Optional: when absent the action is a declarative intent the host
	 * interprets via `id`/`raw`. Errors are the host's to catch.
	 */
	readonly invoke?: () => void | Promise<void>;
	/** Provider-specific payload describing the action. */
	readonly raw?: Json;
}

/**
 * Per-query options handed to every provider. `signal` lets the backend abort a provider when the
 * overall query is cancelled or a per-provider timeout fires. `limit` is an upper bound on results
 * the caller wants back; providers SHOULD respect it but the backend also enforces a final limit
 * after ranking.
 */
export interface QueryOptions {
	/** Abort signal; providers should pass it to fetch/IO and bail when aborted. */
	readonly signal?: AbortSignal;
	/** Soft cap on results the caller wants (per provider). */
	readonly limit?: number;
	/** Free-form, provider-namespaced extras (locale, filters, …). */
	readonly extra?: Readonly<Record<string, Json>>;
}

/** What a provider returns from `query()`. */
export interface QueryResponse {
	readonly results: readonly Result[];
	readonly actions?: readonly Action[];
}

/**
 * THE PROVIDER PROTOCOL. Every search source — web/SearXNG today, notes and calendar tomorrow —
 * implements exactly this. The federation core treats all providers identically; "fancier"
 * providers are just richer `query()` implementations, not a different interface.
 */
export interface Provider {
	/** Unique, stable provider id (e.g. "web", "notes"). */
	readonly id: string;
	/** Human-readable name for UI/provenance. */
	readonly name: string;
	/**
	 * Default weight applied to this provider's scores during ranking, > 0. Lets a host say "trust
	 * notes more than the web" without per-query config. Defaults to 1 when omitted.
	 */
	readonly weight?: number;
	/** Answer a query. MUST honor `opts.signal` for cancellation. */
	query(q: string, opts: QueryOptions): Promise<QueryResponse>;
}

/** Why a provider didn't contribute to a federated result set. */
export interface ProviderError {
	readonly providerId: string;
	/** "timeout" when the per-provider deadline fired, else "error". */
	readonly reason: "timeout" | "error";
	/** The thrown value, preserved for logging. */
	readonly error: unknown;
}

/** The federated answer: a unified ranked list plus provenance/diagnostics. */
export interface SearchResponse {
	/** Merged, deduped, ranked results (best first). */
	readonly results: readonly RankedResult[];
	/** Merged actions (best first), from every provider that returned any. */
	readonly actions: readonly Action[];
	/** Providers that participated successfully (in registration order). */
	readonly providers: readonly string[];
	/** Providers that failed or timed out — the query still succeeds. */
	readonly errors: readonly ProviderError[];
}
