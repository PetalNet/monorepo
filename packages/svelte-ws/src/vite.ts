import fs from "node:fs";
import path from "node:path";

import type { Plugin, ViteDevServer } from "vite";

import { createWebsocketDispatcher } from "./runtime.js";
import type { HandleWebsocket, RouteModule } from "./types.js";

type HttpServer = NonNullable<ViteDevServer["httpServer"]>;

function hooksFilename(root: string): string | null {
	for (const candidate of ["src/hooks.server.ts", "src/hooks.server.js"])
		if (fs.existsSync(path.join(root, candidate))) return candidate;
	return null;
}

/**
 * Dev-server counterpart of the adapter: intercepts non-HMR upgrade requests and dispatches them
 * through crossws to the app's `handleWebsocket` hook, loaded through Vite's SSR module runner so
 * hot updates of the hooks graph take effect on the next connection.
 */
export function websocket(): Plugin {
	let root = process.cwd();
	let vite: ViteDevServer | null = null;

	const loadHandler = async (): Promise<HandleWebsocket | undefined> => {
		const file = hooksFilename(root);
		if (!file || !vite) return undefined;
		const mod = (await vite.ssrLoadModule(path.resolve(root, file))) as RouteModule;
		return mod.handleWebsocket;
	};

	function attach(httpServer: HttpServer | null | undefined): void {
		if (!httpServer) return;
		const dispatcher = createWebsocketDispatcher(loadHandler);
		const previous = httpServer.listeners("upgrade") as ((...args: unknown[]) => void)[];
		httpServer.removeAllListeners("upgrade");
		httpServer.on("upgrade", (req, socket, head) => {
			if (req.headers["sec-websocket-protocol"] === "vite-hmr") {
				for (const listener of previous) listener(req, socket, head);
				return;
			}
			void dispatcher.handleUpgrade(
				req as import("node:http").IncomingMessage,
				socket as import("node:stream").Duplex,
				head as Buffer,
			);
		});
	}

	return {
		name: "svelte-ws",
		configResolved(config) {
			root = config.root;
		},
		configureServer(server) {
			vite = server;
			attach(server.httpServer);
		},
	};
}
