import { existsSync, readFileSync } from "node:fs";

import { scopeConfigSchema } from "./model.ts";
import type { ScopeConfig } from "./model.ts";

export const EMPTY_SCOPE: ScopeConfig = { rooms: [], keywords: [] };

/**
 * Loads the default-deny scope config (denylisted room/session IDs and keywords). The repo ships no
 * real list; the real deny list lives outside the repo and is pointed to by the
 * EPISODES_SCOPE_CONFIG env var.
 *
 * These are two DIFFERENT situations, and pullfrog's review on the first slice found they were
 * being treated identically -- an operator's mistyped path or an unmounted NAS share would silently
 * ingest everything the deny list was supposed to exclude, with no error:
 *
 * - UNSET (no path given at all): intentional no-config default. Returns an empty deny list, but
 *   warns loudly on stderr that no exclusions are active, so this is never silent.
 * - SET but unreadable (a path was explicitly configured and it doesn't exist, or isn't valid
 *   JSON/doesn't match the schema): fails CLOSED. Throws before `ingestRecallDb` opens the source
 *   db or writes anything, so a broken configured path can never advance the cursor or index a
 *   single message under a false sense of exclusion.
 */
export function loadScopeConfig(path: string | undefined): ScopeConfig {
	if (!path) {
		process.stderr.write(
			"[episodes] EPISODES_SCOPE_CONFIG is not set -- ingesting with an EMPTY deny list; no scope exclusions are active.\n",
		);

		return EMPTY_SCOPE;
	}

	if (!existsSync(path)) {
		throw new Error(
			`EPISODES_SCOPE_CONFIG=${path} does not exist. Refusing to ingest without the configured deny list (fail-closed); fix the path, or unset the variable to explicitly run with no exclusions.`,
		);
	}

	return scopeConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** True when a message must be dropped before any redaction or indexing happens. */
export function isDenied(scope: ScopeConfig, room: string, text: string): boolean {
	if (scope.rooms.includes(room)) {
		return true;
	}

	const lower = text.toLowerCase();

	return scope.keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}
