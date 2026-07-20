import { randomUUID } from "node:crypto";

import type { HandleWebsocket } from "@petalnet/svelte-ws";
import type { Peer } from "crossws";

import { consoleApi, consoleServices } from "./api/instance";
import type { Principal } from "./domain/auth/principal";
import { attachBusConnection, type BusSocket } from "./domain/bus/connection";
import { inertExceptionMonitor } from "./domain/observability";
import { resolveSessionPrincipal } from "./session-principal";

/**
 * The console's WebSocket surface, dispatched by SvelteKit (via @petalnet/svelte-ws + crossws): the
 * ordered bus at /api/v1/bus/ws and the terminal seam at /api/v1/terminal/ws. Browser sessions
 * resolve through the better-auth store; agent bearer tokens and dev principals fall through to the
 * console API core's chain, so sockets accept the same credentials as the REST surface.
 */
export const handleWebsocket: HandleWebsocket = async ({ socket, peer, request }) => {
	const path = request.url.pathname;
	if (path !== "/api/v1/bus/ws" && path !== "/api/v1/terminal/ws") {
		socket.close(1008, "unknown websocket path");
		return;
	}
	const [api, services] = await Promise.all([consoleApi(), consoleServices()]);
	// Mirror the REST dispatch's origin gate (console-api dispatch): when a browser origin is
	// configured, an upgrade carrying a different Origin is rejected before any cookie auth is
	// resolved — the CSWSH counterpart of the HTTP path's `origin_denied`. Requests without an
	// Origin header (agent bearer clients) stay origin-agnostic, exactly as on the HTTP path.
	if (api.browserOrigin) {
		const origin = request.headers.get("origin");
		if (origin && origin !== api.browserOrigin) {
			socket.close(1008, "origin is not allowed");
			return;
		}
	}
	const hostname = request.url.hostname;
	const resolvePrincipal = async (): Promise<Principal | null> =>
		(await resolveSessionPrincipal(services, request.headers)) ??
		api.resolvePrincipal(request.headers, hostname);

	if (path === "/api/v1/terminal/ws") {
		const principal = await resolvePrincipal();
		if (!principal) {
			socket.close(1008, "valid credentials required");
			return;
		}
		socket.on("message", () => {
			socket.send(
				JSON.stringify({
					schema_version: 1,
					stream_id: randomUUID(),
					kind: "error",
					seq: 0,
					code: "pty_adapter_unavailable",
				}),
			);
		});
		return;
	}

	const busSocket: BusSocket = toBusSocket(socket, peer);
	attachBusConnection(busSocket, {
		services,
		monitor: inertExceptionMonitor,
		resolvePrincipal,
		refreshable: true,
		counters: api.busCounters,
	});
};

const toBusSocket = (socket: Parameters<HandleWebsocket>[0]["socket"], peer: Peer): BusSocket => ({
	send: (text) => {
		peer.send(text);
	},
	close: () => {
		socket.close();
	},
	isOpen: () => socket.isOpen(),
	onMessage: (handler) => {
		socket.on("message", (data) => {
			handler(data);
		});
	},
	onClose: (handler) => {
		socket.on("close", handler);
	},
});
