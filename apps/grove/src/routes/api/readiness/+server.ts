import { Effect } from "effect";

import { groveApi } from "#lib/server/api.ts";
import { GroveAuth } from "#lib/server/auth.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) =>
	groveApi.runRaw(
		Effect.gen(function* () {
			const auth = yield* GroveAuth;
			const readiness = yield* auth.readiness;

			return Response.json(readiness, {
				status: readiness.status === "ready" ? 200 : 503,
			});
		}),
		event,
	);
