// The WEB provider — the trivial first member of the protocol. It queries a
// self-hosted SearXNG instance's JSON API and maps the hits into the common
// {@link Result} shape. Everything network-specific lives here; the federation
// core and the rest of the package stay pure.
//
// Notes / best-guesses (per the task brief):
//  - Default instance is the lab's SearXNG (`search.petalcat.dev`), overridable.
//  - SearXNG behind Cloudflare 403s "library" user-agents; we send a browser
//    UA by default (see GOTCHA note in the lab memory). Overridable.
//  - SearXNG returns no per-result score, only an ordinal order. We synthesize
//    a [0, 1] score from rank position so the ranker has something to work with.

import type { Json, Provider, QueryOptions, QueryResponse, Result } from "../types.ts";

/** Subset of a SearXNG `/search?format=json` result row that we consume. */
interface SearxngResult {
	readonly url?: string;
	readonly title?: string;
	readonly content?: string;
	readonly engine?: string;
	readonly engines?: readonly string[];
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
}

const DEFAULT_BASE_URL = "https://search.petalcat.dev";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

/**
 * Build a web-search {@link Provider} backed by SearXNG. The returned provider implements the
 * standard protocol, so it registers and federates exactly like any future provider.
 */
export function createWebProvider(options: WebProviderOptions = {}): Provider {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const doFetch = options.fetch ?? globalThis.fetch;
	const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
	const id = options.id ?? "web";

	const provider: Provider = {
		id,
		name: options.name ?? "Web",
		...(options.weight !== undefined ? { weight: options.weight } : {}),
		async query(q: string, opts: QueryOptions): Promise<QueryResponse> {
			const url = new URL(`${baseUrl}/search`);
			url.searchParams.set("q", q);
			url.searchParams.set("format", "json");
			if (options.engines && options.engines.length > 0) {
				url.searchParams.set("engines", options.engines.join(","));
			}

			const res = await doFetch(url, {
				headers: { "User-Agent": userAgent, Accept: "application/json" },
				...(opts.signal ? { signal: opts.signal } : {}),
			});
			if (!res.ok) {
				throw new Error(`SearXNG ${res.status} ${res.statusText} for ${url.pathname}`);
			}
			const body = (await res.json()) as SearxngResponse;
			const rows = body.results ?? [];
			const limited = opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
			const total = limited.length;

			const results: Result[] = limited.map((row, index) => toResult(row, index, total, id));
			return { results };
		},
	};
	return provider;
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
		kind: "web",
		...(timestamp !== undefined ? { timestamp } : {}),
		raw: toJson(row),
	};
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
