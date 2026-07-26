import { readConfig } from "$lib/config";
import { costComparisonRequestSchema } from "$lib/server/domain/cost/compare";
import { compareCostPair, CostComparisonUnavailableError } from "$lib/server/domain/cost/service";
import { currentPrincipal } from "$lib/server/domain/principal";
import { QueryError } from "$lib/server/domain/query/structured";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect } from "effect";
import { Error as HttpError, Query } from "svelte-effect-runtime";

import { mockCostComparison } from "./cost";

/**
 * Server-only RPC boundary for pairwise cost comparison. Runs the comparison domain effect in
 * process against the shared substrate — no HTTP round-trip back through the console's own REST API
 * — exactly like the other remote read planes (see operations.remote.ts). Browser code never calls
 * console-api directly.
 */
export const compareCost = Query(costComparisonRequestSchema, (request) =>
	Effect.gen(function* () {
		const { dataMode } = yield* readConfig;
		if (dataMode === "mock")
			return mockCostComparison(request.dimension, request.left, request.right);
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return yield* compareCostPair(
			services.db.app,
			principal.scopes,
			request,
			services.costMeter,
		).pipe(
			Effect.catch((cause) =>
				cause instanceof CostComparisonUnavailableError
					? HttpError("ServiceUnavailable", cause.message)
					: cause instanceof QueryError
						? HttpError("BadRequest", cause.message)
						: Effect.die(cause),
			),
		);
	}),
);
