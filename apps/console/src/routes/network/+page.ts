import { dataMode, readEdgeRegistry, readEdgeSessions, readExecutors } from "$lib/api/client";
import type { EdgeRegistryItem } from "$lib/api/types";
import {
	mockEdgeHealth,
	mockPendingKey,
	mockRegistry,
	mockSessions,
	mockWireEvents,
} from "$lib/data/network";

import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (dataMode() === "mock") {
		return {
			sessions: mockSessions,
			registry: shell.scene === "asked" ? [mockPendingKey, ...mockRegistry] : mockRegistry,
			sessionsAvailable: true,
			registryAvailable: true,
			health: mockEdgeHealth,
			wire: mockWireEvents,
			observedAt: mockEdgeHealth.updatedAt,
			lanes: shell.me.lanes,
			edgeLive: true,
			managerLive: true,
			controlPlaneLive: true,
			error: null,
		};
	}
	let registry: EdgeRegistryItem[] = [],
		registryAvailable = true;
	try {
		registry = (await readEdgeRegistry(fetch)).items;
	} catch {
		registryAvailable = false;
	}
	const executors = await readExecutors(fetch).catch(() => null);
	const alive = (kind: string) =>
		(executors?.items ?? []).some((item) => item.kind === kind && item.liveness === "alive");
	try {
		const response = await readEdgeSessions(fetch);
		return {
			sessions: response.items,
			registry,
			sessionsAvailable: true,
			registryAvailable,
			health: null,
			wire: [],
			observedAt: response.freshness.observed_at,
			lanes: shell.me.lanes,
			edgeLive: alive("edge"),
			managerLive: alive("manager"),
			controlPlaneLive: alive("control-plane"),
			error: registryAvailable ? null : "Key registry unavailable",
		};
	} catch {
		return {
			sessions: [],
			registry,
			sessionsAvailable: false,
			registryAvailable,
			health: null,
			wire: [],
			observedAt: null,
			lanes: shell.me.lanes,
			edgeLive: alive("edge"),
			managerLive: alive("manager"),
			controlPlaneLive: alive("control-plane"),
			error: "Session projection unavailable",
		};
	}
};
