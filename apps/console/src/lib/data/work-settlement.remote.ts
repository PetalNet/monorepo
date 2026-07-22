import type { WorkSettlementSnapshot } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { mockWorkSettlement } from "$lib/data/work-settlement";
import { currentPrincipal } from "$lib/server/domain/principal";
import { readWorkSettlement } from "$lib/server/domain/reads/work-settlement";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect } from "effect";
import { Query } from "svelte-effect-runtime";

function isMock(): boolean {
	return publicConfig.dataMode === "mock";
}

/** One caller-scoped RPC powers Work's settle strip and Library's task-history projection. */
export const getWorkSettlement = Query(
	Effect.gen(function* () {
		if (isMock()) return mockWorkSettlement();
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		if (!services.tracker) return yield* Effect.die(new Error("Tracker is unavailable"));
		return readWorkSettlement(services.tracker, principal.scopes) as WorkSettlementSnapshot;
	}),
);
