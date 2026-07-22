import { Context, Effect, Layer } from "effect";

import { loadEnv } from "./env";
import { getSharedConsoleServices, setSharedConsoleServices } from "./shared-services";
import { buildServices, type Services } from "./substrate";

/**
 * Transport-agnostic access to the unified console substrate.
 *
 * SvelteKit remote functions, REST handlers, MCP tools, and the custom WebSocket server consume
 * this service. The substrate is initialized once per Node process; none of those transports owns a
 * second copy or a separate deployment boundary.
 */
export class ConsoleDomain extends Context.Service<
	ConsoleDomain,
	{
		readonly services: Effect.Effect<Services, ConsoleDomainUnavailable>;
	}
>()("console/ConsoleDomain") {}

export class ConsoleDomainUnavailable extends Error {
	readonly _tag = "ConsoleDomainUnavailable";

	constructor(readonly cause: unknown) {
		super("The unified console substrate is unavailable", { cause });
	}
}

let processServices: Promise<Services> | undefined;

const acquire = (): Promise<Services> => {
	processServices ??= getSharedConsoleServices() ?? buildServices(loadEnv(), { migrate: false });
	setSharedConsoleServices(processServices);
	return processServices;
};

export const ConsoleDomainLive = Layer.succeed(ConsoleDomain, {
	services: Effect.promise(acquire).pipe(
		Effect.mapError((cause) => new ConsoleDomainUnavailable(cause)),
	),
});
