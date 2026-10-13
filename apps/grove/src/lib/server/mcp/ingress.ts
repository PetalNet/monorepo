import { McpAccess } from "@petalnet/effect-api";
import { Context, Effect } from "effect";
import { HttpServerResponse } from "effect/http";

import {
	ActorAuthority,
	CurrentPrincipal,
	type AuthorityError,
	type MachineIdentity,
} from "../actors/authority";

const authorityUnavailable = (error: AuthorityError) => {
	console.error("Grove MCP actor authority unavailable", error);

	return Effect.fail(
		HttpServerResponse.jsonUnsafe(
			{ error: "authority_unavailable", message: "MCP actor resolution is unavailable" },
			{ status: 503 },
		),
	);
};

const accessDenied = () =>
	Effect.fail(
		HttpServerResponse.jsonUnsafe(
			{ error: "access_denied", message: "MCP identity is not eligible" },
			{ status: 403 },
		),
	);

export const authenticateMachine = (identity: MachineIdentity) =>
	Effect.gen(function* () {
		const authority = yield* ActorAuthority;
		const principal = yield* authority.resolveMachineIdentity(identity);
		const listed = new Set(yield* authority.authorizedOperations(principal));
		const callable = new Set(listed);

		if (principal.kind === "agent" && identity.scopes.has("grove:agent:enroll")) {
			callable.add("agents.enrollSelf");
		}

		return Context.make(CurrentPrincipal, principal).pipe(
			Context.add(McpAccess, { listed, callable }),
		);
	}).pipe(
		Effect.catchTags({
			ActorDatabaseError: authorityUnavailable,
			HomeOwnerUnbound: authorityUnavailable,
			CapabilityContainmentConflict: authorityUnavailable,
			ActorDenied: accessDenied,
			ActorNotCurrent: accessDenied,
		}),
	);
