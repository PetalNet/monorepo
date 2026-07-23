import { Effect } from "effect";
import { RequestEvent } from "svelte-effect-runtime";

import { resolveScopes, type Principal } from "./auth/principal";
import { lanesForTier } from "./auth/tier-lanes";
import { ConsoleDomain } from "./service";

/** Resolve the authenticated Better Auth caller into the substrate's principal vocabulary. */
export const currentPrincipal = Effect.gen(function* () {
	const event = yield* RequestEvent;
	const domain = yield* ConsoleDomain;
	const services = yield* domain.services;
	const user = event.locals.user;
	const tier = event.locals.tier;
	if (!user || !tier) return yield* Effect.die(new Error("Authenticated principal is unavailable"));
	const id = `human:${user.id}`;
	const resolved = yield* Effect.promise(() => resolveScopes(services.db.app, id, [tier]));
	return {
		kind: "human",
		id,
		tiers: [tier],
		lanes: lanesForTier(tier),
		scopes: resolved.scopes,
		zookie: resolved.zookie,
	} satisfies Principal;
});
