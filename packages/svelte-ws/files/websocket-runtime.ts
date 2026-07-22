import process from "node:process";

import { createWebsocketDispatcher } from "@petalnet/svelte-ws/runtime";

/**
 * Production runtime appended to adapter-node's entry: attaches crossws upgrades to the one Node
 * HTTP server and dispatches connections to the compiled server hooks' `handleWebsocket`.
 * SERVER_HOOKS is rewritten at adapt time to the built hooks module.
 */
export default async function attachWebsockets(httpServer) {
	const hooks = await import("SERVER_HOOKS");
	const handleWebsocket = hooks.handleWebsocket;
	// createWebsocketDispatcher takes a loader, not a handler: the dev plugin re-loads the hooks
	// module per connection so HMR edits take effect. In production the module is imported once
	// here, so the loader simply returns the already-resolved handler (undefined if the app exports
	// none, which the dispatcher answers with a 1011 close).
	const dispatcher = createWebsocketDispatcher(() => Promise.resolve(handleWebsocket));
	httpServer.on("upgrade", (req, socket, head) => {
		void dispatcher.handleUpgrade(req, socket, head);
	});
	const shutdown = () => {
		for (const peer of dispatcher.peers) peer.terminate();
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
