import { Context, Effect, type Types } from "effect";
import type { HttpMiddleware, HttpServerResponse } from "effect/http";

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
