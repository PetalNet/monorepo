// Scope-filtered tracker reads (N1b-2). Each read maps tracker visibility → console scope and keeps
// only rows the caller can see (Rule 11). The tracker is live, so freshness.source is "tracker".
//
// The tracker adapter (better-sqlite3) is synchronous, so each read is a pure projection lifted into
// an Effect with `Effect.sync`: a sqlite fault surfaces as a defect (there is no expected business
// failure a caller could recover from), and the effects compose directly into the remote/HTTP planes
// with `yield*` — no promise bridge.

import { Effect } from "effect";

import type { ReadEnvelope } from "./entities.ts";
import { filterByScopes, type TrackerReader, type TrackerRow } from "./tracker.ts";

function envelope(items: TrackerRow[]): ReadEnvelope {
	return {
		schema_version: 1,
		freshness: { source: "tracker", observed_at: new Date().toISOString(), window_s: null },
		items,
		next_cursor: null,
		truncated: false,
	};
}

export function readTasks(
	tracker: TrackerReader,
	scopes: readonly string[],
): Effect.Effect<ReadEnvelope> {
	return Effect.sync(() => envelope(filterByScopes(tracker.tasks(), scopes)));
}

export function readLeases(
	tracker: TrackerReader,
	scopes: readonly string[],
): Effect.Effect<ReadEnvelope> {
	return Effect.sync(() => envelope(filterByScopes(tracker.leases(), scopes)));
}

export function readAgents(
	tracker: TrackerReader,
	scopes: readonly string[],
): Effect.Effect<ReadEnvelope> {
	// agents are fleet-scoped; a caller without `fleet` sees none (flat model).
	return Effect.sync(() => envelope(filterByScopes(tracker.agents(), scopes)));
}
