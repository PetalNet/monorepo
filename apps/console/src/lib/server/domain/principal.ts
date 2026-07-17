import { RequestEvent } from "svelte-effect-runtime";
import { Effect } from "effect";

import { resolveScopes, type Principal } from "./auth/principal";
import { ConsoleDomain } from "./service";

const laneSets = {
	owner: ["viewer", "editor", "operator", "admin", "term_admin"],
	operator: ["viewer", "editor", "operator"],
	editor: ["viewer", "editor"],
	viewer: ["viewer"],
} as const;

/** Resolve the authenticated Better Auth caller into the substrate's principal vocabulary. */
export const currentPrincipal = Effect.gen(function* () {
	const event = yield* RequestEvent;
	const domain = yield* ConsoleDomain;
	const services = yield* domain.services;
	const user = event.locals.user;
	const tier = event.locals.tier;
	if (!user || !tier) return yield* Effect.die(new Error("Authenticated principal is unavailable"));
	const id = `human:${user.id}`;
	const resolved = yield* Effect.tryPromise(() => resolveScopes(services.db.app, id, [tier]));
	return {
		kind: "human",
		id,
		tiers: [tier],
		lanes: [...laneSets[tier]],
		scopes: resolved.scopes,
		zookie: resolved.zookie,
	} satisfies Principal;
});
