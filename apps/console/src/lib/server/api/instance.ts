import { createBetterAuthSessionVerifier } from "../domain/auth/session";
import { loadEnv } from "../domain/env";
import { initExceptionMonitor } from "../domain/observability";
import { getSharedConsoleServices, setSharedConsoleServices } from "../domain/shared-services";
import { buildServices, type Services } from "../domain/substrate";
import { buildConsoleApi, type ConsoleApi } from "./console-api";

let instance: Promise<ConsoleApi> | undefined;

/** The one process-wide substrate, shared with SER remote functions and the WebSocket surface. */
export function consoleServices(): Promise<Services> {
	const shared = getSharedConsoleServices();
	if (shared) return shared;
	const built = buildServices(loadEnv(), { migrate: false });
	setSharedConsoleServices(built);
	return built;
}

/**
 * Process-wide REST surface. Built once from the same shared substrate the SER remote functions
 * use, so the SvelteKit catch-all route, the WebSocket bus, and the remote layer never own a second
 * copy of the domain services.
 */
export function consoleApi(): Promise<ConsoleApi> {
	instance ??= (async () => {
		const env = loadEnv();
		const services = consoleServices();
		const betterAuth = env.betterAuth
			? createBetterAuthSessionVerifier({
					databaseUrl: env.databaseUrl,
					baseUrl: env.betterAuth.baseUrl,
					secret: env.betterAuth.secret,
				})
			: null;
		const api = buildConsoleApi(await services, {
			devAuth: env.devAuth,
			monitor: initExceptionMonitor(env.glitchtipDsn),
			betterAuth,
			devAuthHost: env.devAuthHost ?? null,
		});
		// The adapter entry (`node build/index.js`) owns the HTTP server; the substrate's lifecycle
		// is owned here now that the bespoke Node wrapper is gone.
		const shutdown = () => {
			api.close();
			void services
				.then((active) => active.close())
				.finally(() => {
					process.exit(0);
				});
		};
		process.once("SIGTERM", shutdown);
		process.once("SIGINT", shutdown);
		return api;
	})();
	return instance;
}
