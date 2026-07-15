import { Context, Effect, Layer } from "effect";

export interface ConsoleStatus {
	readonly service: "console";
	readonly status: "ready";
}

export class ConsoleService extends Context.Service<
	ConsoleService,
	{ readonly status: Effect.Effect<ConsoleStatus> }
>()("console/ConsoleService") {}

export const ConsoleServiceLive = Layer.succeed(ConsoleService, {
	status: Effect.succeed<ConsoleStatus>({ service: "console", status: "ready" }),
});
