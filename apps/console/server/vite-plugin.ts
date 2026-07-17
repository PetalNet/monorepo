import { buildServices } from "../src/lib/server/domain/substrate";
import { loadEnv } from "../src/lib/server/domain/env";
import { attachConsoleWebSockets } from "../src/lib/server/ws";
import { principalResolver } from "./principal";
import type { Plugin } from "vite";

/** Dev counterpart of the production Node wrapper: Vite owns HTTP, this plugin owns upgrades. */
export const unifiedConsoleServer = (): Plugin => ({
	name: "unified-console-node-server",
	apply: "serve",
	async configureServer(vite) {
		if (!vite.httpServer) throw new Error("Vite HTTP server is unavailable");
		const services = buildServices(loadEnv(), { migrate: false });
		(globalThis as typeof globalThis & { __LAB_CONSOLE_SERVICES__?: typeof services }).__LAB_CONSOLE_SERVICES__ = services;
		const active = await services;
		const detach = attachConsoleWebSockets(
			vite.httpServer as import("node:http").Server,
			active,
			principalResolver(active),
		);
		return () => vite.httpServer?.once("close", () => void active.close().finally(detach));
	},
});
