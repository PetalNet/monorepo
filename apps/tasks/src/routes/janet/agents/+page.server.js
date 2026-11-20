import { readSnapshot } from "#lib/server/agents/snapshot.ts";

export function load() {
	return { snapshot: readSnapshot() };
}
