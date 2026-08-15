import { GroveAuth } from "$lib/server/auth";
import { runGrove } from "$lib/server/runtime";
import { Effect } from "effect";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) =>
	runGrove(
		Effect.gen(function* () {
			const auth = yield* GroveAuth;
			const readiness = yield* auth.readiness;
			return Response.json(readiness, {
				status: readiness.status === "ready" ? 200 : 503,
			});
		}),
		event,
	);
