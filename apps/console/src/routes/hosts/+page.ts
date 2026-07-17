import { browser } from "$app/env";
import { dataMode, readBoxUpdates, readRegistry, readRoster, readWorkers } from "$lib/rpc/browser";
import type { BoxUpdateItem, RegistryItem, RosterItem, WorkerItem } from "$lib/api/types";
import { assembleHosts, mockHosts, type HostsData } from "$lib/data/hosts";

import type { PageLoad } from "./$types";

/**
 * Hosts surface data (07-hosts §6): the neighborhood grid joins box posture, roster, capacity
 * registry, and worker liveness. Each source retains its own browser-scoped last-known snapshot.
 */
let cachedBoxes: BoxUpdateItem[] | undefined;
let cachedRoster: RosterItem[] | undefined;
let cachedRegistry: RegistryItem[] | undefined;
let cachedWorkers: WorkerItem[] | undefined;

export const load: PageLoad = async ({
	fetch,
}): Promise<{
	hosts: HostsData;
	sources: Record<"updates" | "roster" | "registry" | "workers", "live" | "stale" | "unavailable">;
	isMock: boolean;
}> => {
	if (dataMode() !== "live")
		return {
			hosts: mockHosts(),
			sources: { updates: "live", roster: "live", registry: "live", workers: "live" },
			isMock: true,
		};
	const [boxesRead, rosterRead, registryRead, workersRead] = await Promise.all([
		readBoxUpdates(fetch).catch(() => null),
		readRoster(fetch).catch(() => null),
		readRegistry(fetch).catch(() => null),
		readWorkers(fetch).catch(() => null),
	]);
	if (browser) {
		if (boxesRead) cachedBoxes = boxesRead.items;
		if (rosterRead) cachedRoster = rosterRead.items;
		if (registryRead) cachedRegistry = registryRead.items;
		if (workersRead) cachedWorkers = workersRead.items;
	}
	const boxes = boxesRead?.items ?? (browser ? cachedBoxes : undefined) ?? [];
	const roster = rosterRead?.items ?? (browser ? cachedRoster : undefined) ?? [];
	const registry = registryRead?.items ?? (browser ? cachedRegistry : undefined) ?? [];
	const workers = workersRead?.items ?? (browser ? cachedWorkers : undefined) ?? [];
	return {
		hosts: {
			...assembleHosts(boxes, roster, registry, workers, Date.now()),
			connected: Boolean(
				boxesRead ||
				rosterRead ||
				registryRead ||
				workersRead ||
				cachedBoxes ||
				cachedRoster ||
				cachedRegistry ||
				cachedWorkers,
			),
		},
		sources: {
			updates: boxesRead ? "live" : cachedBoxes ? "stale" : "unavailable",
			roster: rosterRead ? "live" : cachedRoster ? "stale" : "unavailable",
			registry: registryRead ? "live" : cachedRegistry ? "stale" : "unavailable",
			workers: workersRead ? "live" : cachedWorkers ? "stale" : "unavailable",
		},
		isMock: false,
	};
};
