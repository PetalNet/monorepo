import { validateContract } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { mockAvailability } from "$lib/data/availability";
import {
	readAvailability,
	type AvailabilitySnapshot,
} from "$lib/server/domain/availability/service";
import { currentPrincipal } from "$lib/server/domain/principal";
import { readExecutors } from "$lib/server/domain/reads/roster";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect } from "effect";
import { Query } from "svelte-effect-runtime";

interface AvailabilityRemoteResult {
	readonly snapshot: AvailabilitySnapshot;
	readonly probe_runner_live: boolean;
}

/** Server-side RPC for Hosts availability. Browser code never calls console-api directly. */
export const getAvailability = Query(
	Effect.gen(function* () {
		if (publicConfig.dataMode === "mock")
			return {
				snapshot: mockAvailability(),
				probe_runner_live: true,
			} satisfies AvailabilityRemoteResult;
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const [snapshot, executors] = yield* Effect.all(
			[
				readAvailability(services.db.app, principal.scopes, 30 * 86_400),
				readExecutors(services.db.app, principal.scopes),
			],
			{ concurrency: "unbounded" },
		);
		const validation = validateContract("AvailabilitySnapshot", snapshot);
		if (!validation.valid) return yield* Effect.die(new Error("Availability contract failed"));
		return {
			snapshot,
			probe_runner_live: executors.items.some(
				(executor) => executor["kind"] === "probe-runner" && executor["liveness"] === "alive",
			),
		} satisfies AvailabilityRemoteResult;
	}),
);
