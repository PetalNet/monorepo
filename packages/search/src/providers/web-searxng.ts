// The WEB provider — the trivial first member of the protocol. It queries a
// self-hosted SearXNG instance's JSON API and maps the hits into the common
// {@link Result} shape. Everything network-specific lives here; the federation
// core and the rest of the package stay pure.
//
// Notes / best-guesses (per the task brief):
//  - Default instance is the lab's SearXNG (`search.petalcat.dev`), overridable.
//  - SearXNG behind Cloudflare 403s "library" user-agents; we send a browser
//    UA by default (see GOTCHA note in the lab memory). Overridable.
//  - SearXNG returns no reliable per-result score (the `score` it emits is
//    unbounded and engine-dependent), only an ordinal order. We synthesize a
//    [0, 1] score from rank position so the ranker has something to work with.
//  - SearXNG tags each row with a `category` ("general"/"news"/"images"/…) and
//    `engine`. We map category → our {@link ResultKind} so a news hit ranks/renders
//    as a news result, an image as an image, etc., and fall back to "web".
//  - Timeout + graceful failure live HERE too, not just in the federation core:
//    a Provider should be usable standalone, so it owns its own deadline and can
//    opt into returning an empty set (with a "search the web" Action) instead of
//    throwing. Federation still isolates a throwing provider regardless.

import type {
	Action,
	Json,
	Provider,
	QueryOptions,
	QueryResponse,
	Result,
	ResultKind,
} from "../types.ts";

/** Subset of a SearXNG `/search?format=json` result row that we consume. */
interface SearxngResult {
	readonly url?: string;
	readonly title?: string;
	readonly content?: string;
	readonly engine?: string;
	readonly engines?: readonly string[];
	/** SearXNG's per-row category, e.g. "general", "news", "images", "videos". */
	readonly category?: string;
	readonly categories?: readonly string[];
	readonly img_src?: string;
	readonly thumbnail?: string;
	readonly publishedDate?: string | null;
	readonly score?: number;
}

/** Top-level shape of the SearXNG JSON response (the parts we touch). */
interface SearxngResponse {
	readonly results?: readonly SearxngResult[];
	readonly suggestions?: readonly string[];
}

/** Configuration for {@link createWebProvider}. */
export interface WebProviderOptions {
	/** Base URL of the SearXNG instance. Default `https://search.petalcat.dev`. */
	readonly baseUrl?: string;
	/** Provider id. Default `"web"`. */
	readonly id?: string;
	/** Display name. Default `"Web"`. */
	readonly name?: string;
	/** Ranking weight. Default 1. */
	readonly weight?: number;
	/**
	 * Injected fetch — defaults to global `fetch`. Tests pass a fake so the provider stays
	 * unit-testable without a network. Typed to the standard `fetch` signature.
	 */
	readonly fetch?: typeof globalThis.fetch;
	/**
	 * User-Agent header. Defaults to a browser UA because the lab's SearXNG is behind Cloudflare,
	 * which 403s library UAs (python-requests/undici/etc.).
	 */
	readonly userAgent?: string;
	/** Restrict to specific SearXNG engines (`&engines=`). */
	readonly engines?: readonly string[];
	/** Restrict to SearXNG categories (`&categories=`), e.g. `["general", "news"]`. */
	readonly categories?: readonly string[];
	/**
	 * Per-call deadline in ms. The provider aborts its own fetch when this fires (in addition to any
	 * `opts.signal` the caller/federation supplies). Default 5000. Set 0 to disable.
	 */
	readonly timeoutMs?: number;
	/**
	 * When true, a failed query (network error, non-OK status, timeout) resolves to an empty result
	 * set plus a "search the web" {@link Action}, instead of throwing. Lets the provider be used
	 * standalone without a try/catch. Default false — the federation core isolates throws itself, so
	 * inside federation throwing is the right signal (it lands in `errors`). Default false.
	 */
	readonly graceful?: boolean;
}

const DEFAULT_BASE_URL = "https://search.petalcat.dev";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Build a web-search {@link Provider} backed by SearXNG. The returned provider implements the
 * standard protocol, so it registers and federates exactly like any future provider.
 */
export function createWebProvider(options: WebProviderOptions = {}): Provider {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const doFetch = options.fetch ?? globalThis.fetch;
	const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
	const id = options.id ?? "web";
	const name = options.name ?? "Web";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const graceful = options.graceful ?? false;

	const provider: Provider = {
		id,
		name,
		...(options.weight !== undefined ? { weight: options.weight } : {}),
		async query(q: string, opts: QueryOptions): Promise<QueryResponse> {
			try {
				return await runQuery();
			} catch (err) {
				if (graceful) {
					// Surface a "search the web" Action so the host still has a next step.
					return { results: [], actions: [searchAction(q, id, name, baseUrl)] };
				}
				throw err;
			}

			async function runQuery(): Promise<QueryResponse> {
				const url = new URL(`${baseUrl}/search`);
				url.searchParams.set("q", q);
				url.searchParams.set("format", "json");
				if (options.engines && options.engines.length > 0) {
					url.searchParams.set("engines", options.engines.join(","));
				}
				if (options.categories && options.categories.length > 0) {
					url.searchParams.set("categories", options.categories.join(","));
				}

				const signal = combineSignals(opts.signal, timeoutMs);
				const res = await doFetch(url, {
					headers: { "User-Agent": userAgent, Accept: "application/json" },
					...(signal ? { signal } : {}),
				});
				if (!res.ok) {
					throw new Error(`SearXNG ${res.status} ${res.statusText} for ${url.pathname}`);
				}
				const body = (await res.json()) as SearxngResponse;
				const rows = body.results ?? [];
				const limited = opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
				const total = limited.length;

				const results: Result[] = limited.map((row, index) => toResult(row, index, total, id));
				return { results, actions: [searchAction(q, id, name, baseUrl)] };
			}
		},
	};
	return provider;
}

/**
 * Combine the caller's abort signal with a self-imposed timeout. Returns `undefined` only when
 * there is nothing to abort on (no caller signal AND no timeout). Uses `AbortSignal.any`/`.timeout`
 * so the first of {caller-abort, deadline} wins.
 */
function combineSignals(
	caller: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal | undefined {
	const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	if (caller && timeout) return AbortSignal.any([caller, timeout]);
	return caller ?? timeout;
}

/** A "search the web for <q>" action — a next step the host can invoke (opens the SearXNG UI). */
function searchAction(
	q: string,
	providerId: string,
	providerName: string,
	baseUrl: string,
): Action {
	const href = `${baseUrl}/search?q=${encodeURIComponent(q)}`;
	return {
		id: `${providerId}:search`,
		providerId,
		title: `Search ${providerName} for "${q}"`,
		score: 0,
		raw: { url: href, query: q },
	};
}

/** Map one SearXNG row into the common {@link Result} shape. */
function toResult(row: SearxngResult, index: number, total: number, providerId: string): Result {
	// SearXNG's per-result `score` is unbounded and engine-dependent; rather than
	// guess its scale, derive a clean [0, 1] from ordinal rank (already-merged by
	// SearXNG across its engines). Position 0 → ~1, decaying linearly.
	const score = total <= 1 ? 1 : 1 - index / total;
	const timestamp = parseDate(row.publishedDate);
	return {
		id: row.url ?? `${providerId}:${index}`,
		providerId,
		title: row.title ?? row.url ?? "(untitled)",
		...(row.content ? { subtitle: row.content } : {}),
		...(row.url ? { url: row.url } : {}),
		score,
		kind: categoryToKind(row),
		...(timestamp !== undefined ? { timestamp } : {}),
		raw: toJson(row),
	};
}

/**
 * Map a SearXNG row's category (or its `categories[]`) to our {@link ResultKind}. Unknown categories
 * fall back to "web" so the result is never dropped — kinds are open-ended by design.
 */
function categoryToKind(row: SearxngResult): ResultKind {
	const category = row.category ?? row.categories?.[0];
	switch (category) {
		case undefined:
		case "general":
		case "web":
			return "web";
		case "news":
			return "news";
		case "images":
		case "image":
			return "image";
		case "videos":
		case "video":
			return "video";
		case "map":
		case "maps":
			return "map";
		case "music":
			return "music";
		case "files":
		case "file":
			return "file";
		case "science":
		case "it":
		case "social media":
			return category;
		default:
			return "web";
	}
}

function parseDate(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const t = Date.parse(value);
	return Number.isNaN(t) ? undefined : t;
}

/** Shallow, defensive coercion of the row to our `Json` type for `raw`. */
function toJson(row: SearxngResult): Json {
	const out: Record<string, Json> = {};
	for (const [k, v] of Object.entries(row)) {
		if (v === undefined) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
			out[k] = v;
		} else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
			out[k] = v as string[];
		}
	}
	return out;
}
