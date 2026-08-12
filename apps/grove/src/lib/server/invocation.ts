import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect } from "effect";

import type { ActorPrincipal, MachinePrincipal } from "./actors/authority";
import { AuthenticationRequired } from "./authorization";

export interface Invocation {
	readonly principal: ActorPrincipal | MachinePrincipal;
	readonly transport: "browser" | "mcp" | "rest";
	readonly requestId: string;
}

export class InvocationContext extends Context.Service<InvocationContext, Invocation>()(
	"grove/InvocationContext",
) {}

export const withBrowserInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const event = yield* SvelteKitRequestEvent;
		const principal = event.locals.actor;
		if (!principal) return yield* Effect.fail(new AuthenticationRequired());
		return yield* effect.pipe(
			Effect.provideService(InvocationContext, {
				principal,
				transport: event.url.pathname.startsWith("/api/") ? "rest" : "browser",
				requestId: event.request.headers.get("x-request-id") ?? crypto.randomUUID(),
			}),
		);
	});
