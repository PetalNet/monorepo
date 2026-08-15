import { GroveAuth } from "$lib/server/auth";
import { runGrove } from "$lib/server/runtime";
import { Effect } from "effect";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) =>
	runGrove(
		Effect.flatMap(GroveAuth, (auth) => auth.beginLogin(event.request.headers)),
		event,
	);
