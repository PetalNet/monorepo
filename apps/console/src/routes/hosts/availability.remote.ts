import {
	validateContract,
	type AvailabilitySnapshot,
	type ExecutorItem,
	type ReadEnvelope,
} from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { mockAvailability } from "$lib/data/availability";
import { readAvailability } from "$lib/server/domain/availability/service";
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
			return { snapshot: mockAvailability(), probe_runner_live: true };
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const [snapshot, executors] = yield* Effect.all(
			[
				Effect.promise(() => readAvailability(services.db.app, principal.scopes, 30 * 86_400)),
				Effect.promise(() => readExecutors(services.db.app, principal.scopes)),
			],
			{ concurrency: "unbounded" },
		);
		const validation = validateContract("AvailabilitySnapshot", snapshot);
		if (!validation.valid) return yield* Effect.die(new Error("Availability contract failed"));
		return {
			snapshot: snapshot as ReturnType<typeof mockAvailability>,
			probe_runner_live: (executors as ReadEnvelope<ExecutorItem>).items.some(
				(executor) => executor.kind === "probe-runner" && executor.liveness === "alive",
			),
		};
	}),
);
