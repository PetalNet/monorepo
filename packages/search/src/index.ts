// @petalnet/search — the distributed-search spine.
//
// Search is the cross-platform spine: one query fans out to many providers
// (web today; notes/calendar/contacts later — all the same protocol), and the
// federation core merges, dedupes and ranks them into one provenance-tagged
// list. This module is the public surface; see `types.ts` for the protocol.

// Protocol & types.
export type {
	Action,
	Json,
	Provider,
	ProviderError,
	QueryOptions,
	QueryResponse,
	RankedResult,
	Result,
	ResultKind,
	SearchResponse,
} from "./types.ts";

// Registry.
export { ProviderRegistry } from "./registry.ts";

// Ranking (pluggable + default).
export { defaultRanker, rank } from "./rank.ts";
export type { DefaultRankerOptions, RankInput, Ranker } from "./rank.ts";

// Federation core.
export { search } from "./federate.ts";
export type { SearchOptions } from "./federate.ts";

// Providers.
export { createWebProvider } from "./providers/web-searxng.ts";
export type { WebProviderOptions } from "./providers/web-searxng.ts";
