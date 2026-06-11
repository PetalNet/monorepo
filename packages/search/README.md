# @petalnet/search

The **distributed-search spine**: one query fans out to many _providers_ in
parallel; the federation core merges, dedupes, and ranks their answers into a
single, provenance-tagged list. Web/SearXNG is the first provider; notes,
calendar, and contacts are "fancier versions of the same protocol" and slot in
without touching the core.

```text
query ──▶ federate() ──▶ ┌─ provider: web (SearXNG) ─┐
                         ├─ provider: notes  (later) ─┤──▶ merge ▶ dedupe ▶ rank ──▶ unified ranked list
                         └─ provider: calendar(later)─┘                              + actions + provenance
```

## Layout

| File                           | Role                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `src/types.ts`                 | The protocol — pure types, runtime-free. The contract everything shares. |
| `src/federate.ts`              | The federation core: parallel fan-out, failure isolation, dedupe, rank.  |
| `src/rank.ts`                  | Pluggable ranking + the default ranker (`weight × score` + recency).     |
| `src/registry.ts`              | A tiny ordered, id-keyed provider collection.                            |
| `src/providers/web-searxng.ts` | The WEB provider — queries a SearXNG JSON API, maps rows to `Result`.    |
| `src/server.ts`                | The thin HTTP service (`GET /search`, `GET /health`).                    |
| `src/example.ts`               | A runnable, network-free end-to-end demo.                                |

## The protocol

A **provider** answers one query and returns normalized results plus optional
actions:

```ts
interface Provider {
	readonly id: string; // unique, stable ("web", "notes", …)
	readonly name: string; // human-readable, for UI/provenance
	readonly weight?: number; // ranking weight, >0, default 1
	query(q: string, opts: QueryOptions): Promise<QueryResponse>;
}

interface QueryResponse {
	readonly results: readonly Result[];
	readonly actions?: readonly Action[];
}
```

A **`Result`** is the common shape every provider maps into:

```ts
interface Result {
	readonly id: string; // unique WITHIN this provider
	readonly providerId: string; // who produced it (the backend stamps it if omitted)
	readonly title: string;
	readonly subtitle?: string;
	readonly url?: string;
	readonly score: number; // provider-local relevance in [0, 1], higher = better
	readonly kind: ResultKind; // "web" | "news" | "note" | "event" | … (open-ended)
	readonly timestamp?: number; // ms since epoch; drives the recency boost
	readonly raw?: Json; // untouched provider payload
}
```

**Scoring contract.** `score` is the provider's _own_ confidence in `[0, 1]`. A
provider never needs to know about other providers — cross-provider
normalization and weighting happen in the ranker. A provider that only has an
ordinal rank should map it into `[0, 1]` (e.g. `1 - index / total`, which is
exactly what the web provider does).

An **`Action`** is an invokable next step ("Search the web for X", "Create a
note titled X") surfaced alongside results. `invoke` is optional — without it
the action is a declarative intent the host dispatches via `id`/`raw`.

### What the backend guarantees

`search(q, options)` (in `federate.ts`) gives you:

- **Parallel** — every provider is queried concurrently (`Promise.allSettled`).
- **Isolated** — one slow or throwing provider can never sink the query; it
  lands in `response.errors` and the rest still return.
- **Bounded** — each provider gets its own timeout (`perProviderTimeoutMs`,
  default 5000) via an `AbortController`; the caller's `signal` is chained so an
  outer cancel aborts all providers.
- **Deterministic** — identical inputs produce identical ordering. Ties break by
  provider (registration) order, then local score. (Covered by tests in
  `rank.test.ts` / `federate.test.ts`.)
- **Deduped** — hits collide on a normalized `url` or on `providerId:id`;
  first-seen wins, so the higher-priority (earlier-registered) provider keeps the
  result. Dedupe runs _before_ ranking.

The result, `SearchResponse`, carries the ranked `results` (each with a final
`rankScore`), merged `actions`, the list of `providers` that succeeded, and the
`errors` from any that failed/timed out.

## Ranking

The default ranker is intentionally simple and explainable:

```text
rankScore = weight × clamp01(score)  (+ recencyWeight × 2^(-age / halfLife) when a timestamp exists)
```

- `weight` is the provider's `weight` (default 1) — lets a host trust some
  sources more ("notes over web").
- the recency boost adds up to `recencyWeight` (default 0.15) for a brand-new
  item and decays with a half-life (default 7 days). Results without a
  `timestamp` are neither helped nor penalized.

Richer rankers (learned, BM25-blend, …) drop in by implementing the `Ranker`
type and passing it as `options.ranker`.

## Adding a provider

Providers are "fancier versions of the same protocol" — the core treats them all
identically. To add one (say, notes):

1. **Implement `Provider`.** Return `Result`s with a stable `id`, a `score` in
   `[0, 1]`, and a `kind` (reuse `"note"` or introduce your own — `ResultKind`
   is open-ended). Honor `opts.signal` for cancellation, and `opts.limit` as a
   soft cap. Set a `timestamp` if you have one so recency ranking kicks in.

   ```ts
   export function createNotesProvider(opts: NotesProviderOptions): Provider {
   	return {
   		id: "notes",
   		name: "Notes",
   		weight: 1.5, // trust local notes a bit more than the web
   		async query(q, { signal, limit }) {
   			const hits = await searchNotes(q, { signal, limit });
   			return {
   				results: hits.map((h, i) => ({
   					id: h.id,
   					providerId: "notes",
   					title: h.title,
   					subtitle: h.excerpt,
   					score: h.relevance, // already in [0, 1]
   					kind: "note",
   					timestamp: h.updatedAt,
   					raw: h,
   				})),
   			};
   		},
   	};
   }
   ```

2. **Register it** alongside the web provider:

   ```ts
   const registry = new ProviderRegistry()
   	.register(createWebProvider())
   	.register(createNotesProvider(/* … */));
   const res = await search("my query", { providers: registry });
   ```

   Or wire it into the HTTP service by appending to `providersFromEnv()` in
   `server.ts` (today that function returns just the web provider).

3. **Test it** with a fake backing store (no network/IO) — mirror
   `providers/web-searxng.test.ts`: inject the dependency, assert the mapping
   into `Result` shape, the scoring, error/timeout behavior, and any actions.

That's the whole contract. No core changes are needed — federation, dedupe,
ranking, and the HTTP service pick the new provider up automatically.

## The HTTP service

`src/server.ts` is a **thin, framework-free `node:http` server** (chosen over a
full SvelteKit app: the package is otherwise dependency-free, and the service is
genuinely just "run `search()`, return JSON"). The request handler
(`handleSearch`) is exported separately, so a SvelteKit `+server.ts` or an edge
function can reuse the exact logic without the `node:http` wrapper.

### Routes

| Route                         | Returns                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /search?q=<q>&limit=<n>` | Federated, ranked JSON (`SearchHttpResponse`). `limit` is optional, capped at `maxLimit` (default 100); a bad `limit` → `400`. A missing/empty `q` → an empty result set. |
| `GET /health`                 | `{ ok: true, providers: string[] }`.                                                                                                                                      |

The wire response is a serialization-safe projection of `SearchResponse`:
`actions` drop their (non-serializable) `invoke` function — the host re-binds
behavior from `id`/`raw` — and `errors` carry a string `message`.

### Running it

```sh
# from the monorepo root (Node 26)
pnpm --filter @petalnet/search build
pnpm --filter @petalnet/search serve     # node dist/server.js
# or via the bin once linked: petalnet-search-server

curl 'http://localhost:8787/search?q=distributed+search&limit=10'
```

### Configuration (environment)

| Variable             | Default                       | Meaning                                                                                                                                               |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `8787`                        | Listen port.                                                                                                                                          |
| `HOST`               | `0.0.0.0`                     | Bind address.                                                                                                                                         |
| `SEARXNG_URL`        | `https://search.petalcat.dev` | Base URL of the SearXNG instance.                                                                                                                     |
| `SEARXNG_UA`         | a Firefox UA                  | User-Agent sent to SearXNG. **Leave as a browser UA** — the lab's SearXNG is behind Cloudflare, which 403s library UAs (python-requests/undici/etc.). |
| `SEARXNG_ENGINES`    | _(all)_                       | Comma-separated SearXNG engines to restrict to (`&engines=`).                                                                                         |
| `SEARXNG_CATEGORIES` | _(all)_                       | Comma-separated SearXNG categories (`&categories=`), e.g. `general,news`.                                                                             |

### SearXNG specifics

The web provider talks to SearXNG's JSON API:
`GET <baseUrl>/search?q=<q>&format=json`. Notes on the mapping
(`providers/web-searxng.ts`):

- **The instance must allow the `json` output format.** In SearXNG's
  `settings.yml`, `search.formats` must include `json` (the default config ships
  only `html`):

  ```yaml
  search:
    formats:
      - html
      - json
  ```

- **Scoring.** SearXNG's per-row `score` is unbounded and engine-dependent, so
  we ignore it and synthesize a clean `[0, 1]` score from ordinal rank
  (`1 - index / total`) — SearXNG has already merged across its engines, so its
  order is meaningful.
- **Kind.** Each row's `category` (`general`/`news`/`images`/`videos`/…) maps to
  our `ResultKind`; unknown categories fall back to `"web"` so nothing is dropped.
- **Timestamps.** `publishedDate` is parsed into a `timestamp` (feeding the
  recency boost) when present and parseable.
- **Resilience.** The provider owns its own timeout (`timeoutMs`, default 5000)
  and honors the caller's `AbortSignal`. In `graceful` mode it degrades a failure
  to an empty result set plus a "search the web" action instead of throwing;
  inside federation the default (throwing) is correct, since the core isolates
  throws into `errors`.

## Tests

```sh
cd packages/search && pnpm exec vp test run   # or `vp test` to watch
```

The suite (`*.test.ts`) covers ranking determinism and tiebreaks, dedupe
(within- and cross-provider), per-provider timeout/error isolation, the SearXNG
row→`Result` mapping (scores, kinds, dates, fallbacks), the HTTP routes, and an
end-to-end federated query against a mocked SearXNG.

## What's next (not built yet)

- **Notes / calendar / contacts providers** — implement `Provider` against their
  backing stores and register them; the core needs no changes. `providersFromEnv`
  is where the default set grows.
- **Real wiring** — point `SEARXNG_URL` at the live instance and deploy the
  service (it's a plain Node server: process manager / container / SvelteKit
  endpoint, host's choice). Auth, caching, and rate-limiting are deliberately
  left to the host layer.
