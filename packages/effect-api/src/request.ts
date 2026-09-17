import { Context } from "effect";

export interface McpPermissions {
	readonly listed: ReadonlySet<string>;
	readonly callable: ReadonlySet<string>;
}

/** Installed by the HTTP boundary, never captured while registering routes or tools. */
export class ApiRequest extends Context.Service<
	ApiRequest,
	McpPermissions & {
		readonly services: Context.Context<unknown>;
	}
>()("@petalnet/effect-api/Request") {}
