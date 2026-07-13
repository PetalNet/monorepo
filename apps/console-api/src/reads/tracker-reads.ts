// Scope-filtered tracker reads (N1b-2). Each read maps tracker visibility → console scope and keeps
// only rows the caller can see (Rule 11). The tracker is live, so freshness.source is "tracker".

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

export function readTasks(tracker: TrackerReader, scopes: readonly string[]): ReadEnvelope {
	return envelope(filterByScopes(tracker.tasks(), scopes));
}

export function readLeases(tracker: TrackerReader, scopes: readonly string[]): ReadEnvelope {
	return envelope(filterByScopes(tracker.leases(), scopes));
}

export function readAgents(tracker: TrackerReader, scopes: readonly string[]): ReadEnvelope {
	// agents are fleet-scoped; a caller without `fleet` sees none (flat model).
	return envelope(filterByScopes(tracker.agents(), scopes));
}
