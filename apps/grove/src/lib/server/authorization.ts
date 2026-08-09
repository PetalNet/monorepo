import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Effect } from "effect";

export class AuthenticationRequired extends Error {
	readonly _tag = "AuthenticationRequired";

	constructor() {
		super("Authentication required");
	}
}

/** Resolve identity only from the server-validated session attached by the global hook. */
export const requireAuthenticatedUser = Effect.flatMap(SvelteKitRequestEvent, (event) =>
	event.locals.user ? Effect.succeed(event.locals.user) : Effect.fail(new AuthenticationRequired()),
);

/** Resolve MCP identity only from a validated bearer token, never a browser session cookie. */
export const requireMcpPrincipal = Effect.flatMap(SvelteKitRequestEvent, (event) =>
	event.locals.mcpPrincipal
		? Effect.succeed(event.locals.mcpPrincipal)
		: Effect.fail(new AuthenticationRequired()),
);
