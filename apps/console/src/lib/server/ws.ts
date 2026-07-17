import type { IncomingMessage, Server } from "node:http";
import { randomUUID } from "node:crypto";

import type { Principal } from "./domain/auth/principal";
import type { Services } from "./domain/substrate";
import { WebSocket, WebSocketServer, type RawData } from "ws";

type ResolvePrincipal = (request: IncomingMessage) => Promise<Principal | null>;

const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** Attach the ordered bus and terminal upgrade paths to the one Node HTTP server. */
export function attachConsoleWebSockets(
	server: Server,
	services: Services,
	resolvePrincipal: ResolvePrincipal,
): () => void {
	const sockets = new WebSocketServer({ noServer: true });
	const principals = new WeakMap<WebSocket, Principal>();
	const onUpgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
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
		if (!principal) return socket.close(1008, "principal unavailable");
		const ownerId = `${principal.id}:${randomUUID()}`;
		const subscriptions = new Set<string>();
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
		const stopGrantWatch = services.onGrantChange(() => {
			services.broker.revalidateScopes(ownerId, [...subscriptions], principal.scopes);
		});
		socket.on("message", (bytes: RawData) => {
			let raw: Record<string, unknown> | null = null;
			try {
				raw = object(JSON.parse(bytes.toString()) as unknown);
			} catch {
				socket.close(1007, "invalid JSON");
				return;
			}
			if (!raw || raw["action"] !== "subscribe" || typeof raw["sub_id"] !== "string" || typeof raw["pattern"] !== "string") {
				socket.close(1008, "invalid subscription");
				return;
			}
			const subId = raw["sub_id"];
			void services.broker.subscribe(
				ownerId,
				{
					subId,
					pattern: raw["pattern"],
					scopes: principal.scopes,
					...(typeof raw["since"] === "number" ? { since: raw["since"] } : {}),
					...(object(raw["filter"]) ? { filter: object(raw["filter"]) as never } : {}),
				},
				(frame) => {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
				},
				() => subscriptions.add(subId),
			);
		});
		socket.on("close", () => {
			stopGrantWatch();
			for (const subId of subscriptions) services.broker.unsubscribe(ownerId, subId);
		});
	});

	return () => {
		server.off("upgrade", onUpgrade);
		sockets.close();
	};
}
