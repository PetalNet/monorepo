import { Context, Effect, type Types } from "effect";
import type { HttpMiddleware, HttpServerResponse } from "effect/http";

/** HttpRouter uses `Types.unhandled` to track downstream errors middleware must preserve. */
export type RequestMiddleware = HttpMiddleware.HttpMiddleware.Applied<
	Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled, unknown>,
	Types.unhandled,
	unknown
>;

/** The host supplies request services; native router dispatch erases their requirements. */
export const inHostRequest = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.updateContext(effect, (context: Context.Context<never>) => context as Context.Context<R>);

export interface McpPermissions {
	readonly listed: ReadonlySet<string>;
	readonly callable: ReadonlySet<string>;
}

export interface McpAuthBoundary {
	readonly middleware: RequestMiddleware;
	readonly metadata: () => {
		readonly resource: string;
		readonly authorization_servers: readonly string[];
		readonly bearer_methods_supported: readonly string[];
		readonly scopes_supported: readonly string[];
	};
}

/** Provider-neutral MCP admission and protected-resource metadata. */
export class McpAuthentication extends Context.Service<McpAuthentication, McpAuthBoundary>()(
	"@petalnet/effect-api/McpAuthentication",
) {}

/** Shared transport endpoint for authentication resource URLs and discovery. */
export const McpEndpoint = Context.Reference("@petalnet/effect-api/McpEndpoint", {
	defaultValue: (): `/${string}` => "/mcp",
});

/** Per-request tool discovery and invocation permissions. */
export class McpAccess extends Context.Service<McpAccess, McpPermissions>()(
	"@petalnet/effect-api/McpAccess",
) {}

/** Installed by the HTTP boundary, never captured while registering routes or tools. */
export class ApiRequest extends Context.Service<
	ApiRequest,
	McpPermissions & {
		readonly services: Context.Context<unknown>;
	}
>()("@petalnet/effect-api/Request") {}
