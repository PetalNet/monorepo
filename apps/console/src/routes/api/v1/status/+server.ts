import { Effect } from "effect";
import { Handler } from "svelte-effect-runtime/server";

import { getStatus } from "../../../status.remote";
import type { RequestHandler } from "./$types";

// REST facade over the canonical status remote function; delegates rather than re-implementing.
// getStatus() runs the canonical effect directly on the server, so its remote transport/validation
// error channel can't occur here — surface any unexpected failure as a 500.
export const GET = Handler<RequestHandler>(function* () {
	const status = yield* Effect.orDie(getStatus());
	return Response.json(status);
});
