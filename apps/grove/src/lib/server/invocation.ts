import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect } from "effect";
import { HttpServerResponse } from "effect/http";

import type { ActorPrincipal, MachinePrincipal } from "./actors/authority";
import { AuthenticationRequired } from "./authorization";

export interface Invocation {
	readonly principal: ActorPrincipal | MachinePrincipal;
}

export class InvocationContext extends Context.Service<InvocationContext, Invocation>()(
	"grove/InvocationContext",
) {}

export const withBrowserInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const event = yield* SvelteKitRequestEvent;
		const principal = event.locals.actor;

		if (!principal) {
			return yield* new AuthenticationRequired();
		}

		return yield* effect.pipe(
			Effect.provideService(InvocationContext, {
				principal,
			}),
		);
	});

export const withRestInvocation = <E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
	Effect.gen(function* () {
		const event = yield* SvelteKitRequestEvent;
		const principal = event.locals.actor;

		if (!principal) {
			return HttpServerResponse.jsonUnsafe(
				{ error: { code: "operation_failed", message: new AuthenticationRequired().message } },
				{ status: 401 },
			);
		}

		return yield* Effect.provideService(effect, InvocationContext, { principal });
	});
