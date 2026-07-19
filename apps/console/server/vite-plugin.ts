import type { Plugin } from "vite";

import { loadEnv } from "../src/lib/server/domain/env";
import { setSharedConsoleServices } from "../src/lib/server/domain/shared-services";
import { buildServices } from "../src/lib/server/domain/substrate";
import { nodeHeadersToWeb, principalResolver } from "./principal";

/** Dev counterpart of the production Node wrapper: Vite owns HTTP, this plugin owns upgrades. */
export const unifiedConsoleServer = (): Plugin => ({
	name: "unified-console-node-server",
	apply: "serve",
	async configureServer(vite) {
		// Vitest creates a Vite dev server without an HTTP listener. There are no upgrade paths to
		// attach in that environment, and constructing the domain substrate would leak test resources.
		if (!vite.httpServer) return;
		const services = buildServices(loadEnv(), { migrate: false });
		setSharedConsoleServices(services);
		// Loaded through Vite's module runner (not the config bundle) so the API core's compiled-in
		// contract globs resolve, and so the dev server shares one module graph with SSR routes.
		const [{ consoleApi }, { attachConsoleWebSockets }] = (await Promise.all([
			vite.ssrLoadModule("/src/lib/server/api/instance.ts"),
			vite.ssrLoadModule("/src/lib/server/ws.ts"),
		])) as [
			{ consoleApi: () => Promise<import("../src/lib/server/api/console-api").ConsoleApi> },
			{ attachConsoleWebSockets: typeof import("../src/lib/server/ws").attachConsoleWebSockets },
		];
		const [active, api] = await Promise.all([services, consoleApi()]);
		const sessionResolver = principalResolver(active);
		const detach = attachConsoleWebSockets(
			vite.httpServer as import("node:http").Server,
			active,
			async (request) =>
				(await sessionResolver(request)) ??
				api.resolvePrincipal(
					nodeHeadersToWeb(request.headers),
					request.headers.host?.split(":")[0] ?? "",
				),
			{ counters: api.busCounters },
		);
		return () => vite.httpServer?.once("close", () => void active.close().finally(detach));
	},
});
