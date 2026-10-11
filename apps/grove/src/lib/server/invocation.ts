import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";

import type { ActorPrincipal, MachinePrincipal } from "./actors/authority";
import { AuthenticationRequired } from "./authorization";

export interface Invocation {
	readonly principal: ActorPrincipal | MachinePrincipal;
}

export class InvocationContext extends Context.Service<InvocationContext, Invocation>()(
	"grove/InvocationContext",
) {}

export const RestAuthenticationFailure = Schema.Struct({
	error: Schema.Struct({
		code: Schema.Literal("operation_failed"),
		message: Schema.Literal(new AuthenticationRequired().message),
	}),
}).annotate({ httpApiStatus: 401 });

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
				RestAuthenticationFailure.make({
					error: { code: "operation_failed", message: new AuthenticationRequired().message },
				}),
				{ status: 401 },
			);
		}

		return yield* Effect.provideService(effect, InvocationContext, { principal });
	});
