import { Context, Effect, Layer } from "effect";

import { loadEnv } from "./env";
import { buildServices, type Services } from "./substrate";

/**
 * Transport-agnostic access to the unified console substrate.
 *
 * SvelteKit remote functions, REST handlers, MCP tools, and the custom WebSocket server consume
 * this service. The substrate is initialized once per Node process; none of those transports owns
 * a second copy or a separate deployment boundary.
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

const unifiedGlobal = globalThis as typeof globalThis & {
	__LAB_CONSOLE_SERVICES__?: Promise<Services>;
};

const acquire = (): Promise<Services> => {
	processServices ??=
		unifiedGlobal.__LAB_CONSOLE_SERVICES__ ?? buildServices(loadEnv(), { migrate: false });
	unifiedGlobal.__LAB_CONSOLE_SERVICES__ = processServices;
	return processServices;
};

export const closeConsoleDomain = async (): Promise<void> => {
	const active = processServices;
	processServices = undefined;
	delete unifiedGlobal.__LAB_CONSOLE_SERVICES__;
	if (active) await (await active).close();
};

export const ConsoleDomainLive = Layer.succeed(ConsoleDomain, {
	services: Effect.tryPromise({
		try: acquire,
		catch: (cause) => new ConsoleDomainUnavailable(cause),
	}),
});
