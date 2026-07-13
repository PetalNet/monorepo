import { dataMode, readExecutors, readGovernance } from "$lib/api/client";
import {
	agents,
	breakdowns,
	daily,
	mockGovernance,
	mockPool,
	prices,
	sessions,
} from "$lib/data/cost";

import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (dataMode() === "mock")
		return {
			ledgerAvailable: true,
			governanceAvailable: true,
			controlPlaneLive: true,
			isMock: true,
			observedAt: new Date().toISOString(),
			governance: mockGovernance,
			pool: mockPool,
			daily,
			breakdowns,
			agents,
			sessions,
			prices,
			lanes: shell.me.lanes,
		};
	const [governance, executors] = await Promise.all([
		readGovernance(fetch).catch(() => null),
		readExecutors(fetch).catch(() => null),
	]);
	return {
		ledgerAvailable: false,
		governanceAvailable: governance !== null,
		controlPlaneLive: (executors?.items ?? []).some(
			(item) => item.kind === "control-plane" && item.liveness === "alive",
		),
		isMock: false,
		observedAt: governance?.freshness.observed_at ?? null,
		governance: governance?.items ?? [],
		pool: governance?.pool ?? null,
		daily: [],
		breakdowns: { agent: [], model: [], project: [] },
		agents: [],
		sessions: [],
		prices: [],
		lanes: shell.me.lanes,
	};
};
