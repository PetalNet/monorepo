import type { Plugin } from "vite";

import { loadEnv } from "../src/lib/server/domain/env";
import { setSharedConsoleServices } from "../src/lib/server/domain/shared-services";
import { buildServices } from "../src/lib/server/domain/substrate";
import { attachConsoleWebSockets } from "../src/lib/server/ws";
import { principalResolver } from "./principal";

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
		const active = await services;
		const detach = attachConsoleWebSockets(
			vite.httpServer as import("node:http").Server,
			active,
			principalResolver(active),
		);
		return () => vite.httpServer?.once("close", () => void active.close().finally(detach));
	},
});
