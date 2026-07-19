import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { Principal } from "./domain/auth/principal";
import { attachBusConnection, type BusCounters, type BusSocket } from "./domain/bus/connection";
import { inertExceptionMonitor, type ExceptionMonitor } from "./domain/observability";
import type { Services } from "./domain/substrate";

type ResolvePrincipal = (request: IncomingMessage) => Promise<Principal | null>;

export interface ConsoleSocketOptions {
	readonly monitor?: ExceptionMonitor;
	/** Shared with the HTTP surface so /api/v1/health reports live socket counts. */
	readonly counters?: BusCounters;
}

/** Attach the ordered bus and terminal upgrade paths to the one Node HTTP server. */
export function attachConsoleWebSockets(
	server: Server,
	services: Services,
	resolvePrincipal: ResolvePrincipal,
	options: ConsoleSocketOptions = {},
): () => void {
	const monitor = options.monitor ?? inertExceptionMonitor;
	const counters = options.counters ?? { clients: 0, subscriptions: 0 };
	const sockets = new WebSocketServer({ noServer: true });
	const principals = new WeakMap<WebSocket, Principal>();
	const onUpgrade = (
		request: IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
	) => {
		const path = new URL(request.url ?? "/", "http://console.local").pathname;
		if (path !== "/api/v1/bus/ws" && path !== "/api/v1/terminal/ws") return;
		void resolvePrincipal(request).then((principal) => {
			if (!principal) return socket.destroy();
			sockets.handleUpgrade(request, socket, head, (webSocket) => {
				principals.set(webSocket, principal);
				sockets.emit("connection", webSocket, request);
			});
			return undefined;
		});
	};
	server.on("upgrade", onUpgrade);

	sockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
		const principal = principals.get(socket);
		if (!principal) {
			socket.close(1008, "principal unavailable");
			return;
		}
		const path = new URL(request.url ?? "/", "http://console.local").pathname;
		if (path === "/api/v1/terminal/ws") {
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
		const busSocket: BusSocket = {
			send: (text) => {
				socket.send(text);
			},
			close: () => {
				socket.close();
			},
			isOpen: () => socket.readyState === WebSocket.OPEN,
			onMessage: (handler) => {
				socket.on("message", (data: RawData) => {
					handler(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
				});
			},
			onClose: (handler) => {
				socket.on("close", handler);
			},
		};
		attachBusConnection(busSocket, {
			services,
			monitor,
			resolvePrincipal: () => resolvePrincipal(request),
			refreshable: true,
			counters,
		});
	});

	return () => {
		server.off("upgrade", onUpgrade);
		sockets.close();
	};
}
