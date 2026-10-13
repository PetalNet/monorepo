import { operationError, type OperationErrors } from "@petalnet/effect-api";
import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect } from "effect";

import { CurrentPrincipal } from "./actors/authority";
import { AuthenticationRequired } from "./authorization";

export const authenticationErrors = {
	AuthenticationRequired: operationError(AuthenticationRequired, {
		status: 401,
		message: "Authentication required",
	}),
} satisfies OperationErrors<AuthenticationRequired>;

/** Browser identity policy; the server supplies these services to authenticated work. */
export const browserAuthentication = Effect.gen(function* () {
	const event = yield* SvelteKitRequestEvent;
	const principal = event.locals.actor;

	if (!principal) {
		return yield* new AuthenticationRequired();
	}

	return Context.make(CurrentPrincipal, principal);
});
