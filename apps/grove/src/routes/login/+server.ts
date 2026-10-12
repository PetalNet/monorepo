import { Effect } from "effect";

import { groveApi } from "#lib/server/api.ts";
import { GroveAuth } from "#lib/server/auth.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) =>
	groveApi.runRaw(
		Effect.flatMap(GroveAuth, (auth) => auth.beginLogin(event.request.headers)),
		event,
	);
