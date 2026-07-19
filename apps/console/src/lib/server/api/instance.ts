import { createBetterAuthSessionVerifier } from "../domain/auth/session";
import { loadEnv } from "../domain/env";
import { initExceptionMonitor } from "../domain/observability";
import { getSharedConsoleServices, setSharedConsoleServices } from "../domain/shared-services";
import { buildServices } from "../domain/substrate";
import { buildConsoleApi, type ConsoleApi } from "./console-api";

let instance: Promise<ConsoleApi> | undefined;

/**
 * Process-wide REST surface. Built once from the same shared substrate the SER remote functions
 * use, so the SvelteKit catch-all route, the WebSocket bus, and the remote layer never own a
 * second copy of the domain services.
 */
export function consoleApi(): Promise<ConsoleApi> {
	instance ??= (async () => {
		const env = loadEnv();
		const services =
			getSharedConsoleServices() ??
			(() => {
				const built = buildServices(env, { migrate: false });
				setSharedConsoleServices(built);
				return built;
			})();
		const betterAuth = env.betterAuth
			? createBetterAuthSessionVerifier({
					databaseUrl: env.databaseUrl,
					baseUrl: env.betterAuth.baseUrl,
					secret: env.betterAuth.secret,
				})
			: null;
		return buildConsoleApi(await services, {
			devAuth: env.devAuth,
			monitor: initExceptionMonitor(env.glitchtipDsn),
			betterAuth,
			devAuthHost: env.devAuthHost ?? null,
		});
	})();
	return instance;
}
