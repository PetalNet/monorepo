// A thin HTTP service over the federated search backend.
//
// CHOICE (per the stage-3 brief): this is a tiny *framework-free* Node server
// built on `node:http`, living inside the search package itself. Rationale:
//  - The package is otherwise runtime-free and dependency-free; a standalone
//    `node:http` server keeps it that way (no SvelteKit/Express/new catalog dep).
//  - The "service" is a thin skeleton — one route that runs `search()` and
//    returns JSON. A whole SvelteKit app would be ceremony around three lines.
//  - It still slots into the monorepo: a host (a SvelteKit `+server.ts`, a
//    Cloudflare worker, whatever) can import {@link handleSearch} directly and
//    skip the `node:http` wrapper entirely. The HTTP plumbing and the request
//    handling are deliberately separable for exactly that reason.
//
// Routes:
//   GET /search?q=<query>&limit=<n>   → federated, ranked JSON (see SearchHttpResponse)
//   GET /health                       → { ok: true, providers: string[] }
//
// Config comes from the environment (see {@link providersFromEnv}); the default
// provider set is just the web/SearXNG provider pointed at the lab instance.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { search, type SearchOptions } from "./federate.ts";
import { createWebProvider } from "./providers/web-searxng.ts";
import { ProviderRegistry } from "./registry.ts";
import type { Action, Provider, ProviderError, RankedResult } from "./types.ts";

/**
 * The JSON body returned by `GET /search`. This is the wire shape — a serialization-safe projection
 * of {@link import("./types.ts").SearchResponse}: - `actions` drop their (non-serializable) `invoke`
 * function; the host re-binds behavior from `id`/`raw`. - `errors` carry a string `message` instead
 * of the raw thrown value, which may not be JSON-serializable.
 */
export interface SearchHttpResponse {
	readonly query: string;
	readonly results: readonly RankedResult[];
	readonly actions: readonly SerializableAction[];
	readonly providers: readonly string[];
	readonly errors: readonly SerializableError[];
}

/** An {@link Action} without its `invoke` function, safe to JSON-serialize. */
export type SerializableAction = Omit<Action, "invoke">;

/** A {@link ProviderError} flattened to a string message for the wire. */
export interface SerializableError {
	readonly providerId: string;
	readonly reason: ProviderError["reason"];
	readonly message: string;
}

/** Options for {@link createSearchServer} / {@link handleSearch}. */
export interface SearchServerOptions {
	/** Providers to federate. Defaults to {@link providersFromEnv}. */
	readonly providers?: ProviderRegistry | readonly Provider[];
	/** Forwarded into each federated `search()` call. */
	readonly searchOptions?: Omit<SearchOptions, "providers">;
	/** Hard cap on `limit` a client may request. Default 100. */
	readonly maxLimit?: number;
}

const DEFAULT_MAX_LIMIT = 100;

/** Parse a comma-separated env value into a trimmed, non-empty list (or undefined). */
function csv(v: string | undefined): readonly string[] | undefined {
	if (!v) return undefined;
	const parts = v
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return parts.length > 0 ? parts : undefined;
}

/**
 * Core request handler, transport-agnostic. Given a parsed query + limit, run the federated search
 * and return the wire-shaped response. Exported so a host (SvelteKit endpoint, edge function) can
 * reuse the exact same logic without the `node:http` wrapper.
 */
export async function handleSearch(
	q: string,
	limit: number | undefined,
	options: SearchServerOptions = {},
): Promise<SearchHttpResponse> {
	const providers = options.providers ?? providersFromEnv();
	const response = await search(q, {
		...options.searchOptions,
		providers,
		...(limit !== undefined ? { limit } : {}),
	});
	return {
		query: q,
		results: response.results,
		actions: response.actions.map(stripInvoke),
		providers: response.providers,
		errors: response.errors.map(toSerializableError),
	};
}

/**
 * Build a `node:http` {@link Server} that serves the search API. Does not call `.listen()` — the
 * caller decides the port (see {@link startFromEnv} for the batteries-included entrypoint).
 */
export function createSearchServer(options: SearchServerOptions = {}): Server {
	// Resolve providers once at construction so every request shares them (and
	// `/health` can report them) rather than rebuilding per request.
	const providers = options.providers ?? providersFromEnv();
	const maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;
	const providerIds = (providers instanceof ProviderRegistry ? providers.list() : providers).map(
		(p) => p.id,
	);

	return createServer((req, res) => {
		// `void` the promise: we handle all errors inside; nothing should reject.
		void route(req, res, { ...options, providers, maxLimit }, providerIds);
	});
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	options: SearchServerOptions,
	providerIds: readonly string[],
): Promise<void> {
	try {
		// Only GET is supported; everything is read-only.
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "method_not_allowed" });
			return;
		}
		// `req.url` is path+query; resolve against a dummy origin to parse it.
		const url = new URL(req.url ?? "/", "http://localhost");

		if (url.pathname === "/health") {
			sendJson(res, 200, { ok: true, providers: providerIds });
			return;
		}

		if (url.pathname === "/search") {
			const q = url.searchParams.get("q") ?? "";
			const limit = parseLimit(
				url.searchParams.get("limit"),
				options.maxLimit ?? DEFAULT_MAX_LIMIT,
			);
			if (limit instanceof Error) {
				sendJson(res, 400, { error: "bad_limit", message: limit.message });
				return;
			}
			const body = await handleSearch(q, limit, options);
			sendJson(res, 200, body);
			return;
		}

		sendJson(res, 404, { error: "not_found" });
	} catch (err) {
		// Federation itself isolates provider failures, so reaching here means an
		// unexpected internal fault. Surface a generic 500 with a message.
		sendJson(res, 500, { error: "internal", message: errorMessage(err) });
	}
}

/**
 * Parse the `limit` query param. Returns `undefined` (use the backend default) when absent, a
 * clamped positive integer when valid, or an `Error` describing why it was rejected.
 */
function parseLimit(raw: string | null, maxLimit: number): number | undefined | Error {
	if (raw === null || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		return new Error(`limit must be a positive integer, got "${raw}"`);
	}
	return Math.min(n, maxLimit);
}

function stripInvoke(action: Action): SerializableAction {
	const { invoke: _invoke, ...rest } = action;
	return rest;
}

function toSerializableError(err: ProviderError): SerializableError {
	return { providerId: err.providerId, reason: err.reason, message: errorMessage(err.error) };
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

/**
 * Build the default provider set from environment variables:
 *
 * - `SEARXNG_URL` — base URL of the SearXNG instance (default the lab's).
 * - `SEARXNG_UA` — override the User-Agent (lab SearXNG is behind Cloudflare, which 403s library UAs;
 *   the provider defaults to a browser UA).
 * - `SEARXNG_ENGINES` — comma-separated SearXNG engines to restrict to.
 * - `SEARXNG_CATEGORIES` — comma-separated SearXNG categories to restrict to.
 *
 * Only the web provider exists today; notes/calendar/contacts providers will be appended here (or
 * injected via {@link SearchServerOptions.providers}) once built.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
	const engines = csv(env["SEARXNG_ENGINES"]);
	const categories = csv(env["SEARXNG_CATEGORIES"]);
	const baseUrl = env["SEARXNG_URL"];
	const userAgent = env["SEARXNG_UA"];

	const registry = new ProviderRegistry();
	registry.register(
		createWebProvider({
			...(baseUrl ? { baseUrl } : {}),
			...(userAgent ? { userAgent } : {}),
			...(engines ? { engines } : {}),
			...(categories ? { categories } : {}),
		}),
	);
	return registry;
}

/**
 * Batteries-included entrypoint: build a server from the environment and start listening. `PORT`
 * (default 8787) and `HOST` (default 0.0.0.0) come from env. Returns the listening {@link Server} so
 * callers can close it (e.g. in tests).
 */
export function startFromEnv(env: NodeJS.ProcessEnv = process.env): Server {
	const server = createSearchServer();
	const port = Number(env["PORT"] ?? 8787);
	const host = env["HOST"] ?? "0.0.0.0";
	server.listen(port, host, () => {
		console.log(`[search] listening on http://${host}:${port}`);
	});
	return server;
}

// When run directly (`node …/server.js`), boot the service.
if (import.meta.url === `file://${process.argv[1]}`) {
	startFromEnv();
}
