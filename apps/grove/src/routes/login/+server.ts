import { Effect } from "effect";

import { GroveAuth } from "#lib/server/auth.ts";
import { runGrove } from "#lib/server/runtime.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) =>
	runGrove(
		Effect.flatMap(GroveAuth, (auth) => auth.beginLogin(event.request.headers)),
		event,
	);
