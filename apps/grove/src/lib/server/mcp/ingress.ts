import {
	createMcpAuthentication,
	McpAccess,
	type McpAuthenticationConfig,
	type McpAuthentication as McpIngress,
	type RequestMiddleware,
} from "@petalnet/effect-api";
import { Context, Effect } from "effect";
import { HttpServerResponse } from "effect/http";

import { ActorAuthority, CurrentPrincipal, type AuthorityError } from "../actors/authority";

export type { McpAuthentication as McpIngress } from "@petalnet/effect-api";
export type McpIngressConfig = Pick<
	McpAuthenticationConfig,
	"issuer" | "jwksUrl" | "resourceOrigin"
>;

export class McpAuthentication extends Context.Service<McpAuthentication, RequestMiddleware>()(
	"grove/McpAuthentication",
) {}

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

export const makeMcpIngress = (config: McpIngressConfig): McpIngress =>
	createMcpAuthentication({
		...config,
		requiredScopes: ["grove:mcp"],
		scopesSupported: ["grove:mcp", "grove:agent:enroll"],
		authenticate: (identity) =>
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
			),
	});
