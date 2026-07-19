import type { Peer } from "crossws";
import type { NodeAdapter } from "crossws/adapters/node";
import crossws from "crossws/adapters/node";

import type { ConnectionSocket, HandleWebsocket, WebsocketEvent } from "./types.js";

interface ConnectionState {
	socket: ConnectionSocket;
	onMessage: ((data: Uint8Array) => void)[];
	onClose: (() => void)[];
	open: boolean;
}

/**
 * Bridge crossws' adapter-level hooks back to a per-connection handler: `open` builds the
 * connection event and invokes the app handler; `message`/`close` fan back out to the connection
 * that owns the peer. The transport is entirely crossws — no direct `ws` dependency.
 */
export function createWebsocketDispatcher(
	loadHandler: () => Promise<HandleWebsocket | undefined>,
): NodeAdapter {
	const connections = new Map<string, ConnectionState>();
	return crossws({
		hooks: {
			async open(peer: Peer) {
				const handler = await loadHandler();
				if (!handler) {
					peer.close(1011, "no websocket handler");
					return;
				}
				const state: ConnectionState = {
					onMessage: [],
					onClose: [],
					open: true,
					socket: {
						send(data) {
							peer.send(data);
						},
						close(code, reason) {
							peer.close(code, reason);
						},
						terminate() {
							peer.terminate();
						},
						isOpen() {
							return connections.get(peer.id)?.open ?? false;
						},
						on(event, handler) {
							if (event === "message") state.onMessage.push(handler as (data: Uint8Array) => void);
							else state.onClose.push(handler as () => void);
						},
					},
				};
				connections.set(peer.id, state);
				const url = new URL(peer.request.url);
				const event: WebsocketEvent = {
					socket: state.socket,
					peer,
					request: {
						url: Object.freeze(url),
						headers: peer.request.headers,
						protocol: url.protocol === "wss:" || url.protocol === "https:" ? "wss" : "ws",
					},
					locals: {},
				};
				await handler(event);
			},
			message(peer, message) {
				const state = connections.get(peer.id);
				if (!state) return;
				const data = message.uint8Array();
				for (const listener of state.onMessage) listener(data);
			},
			close(peer) {
				const state = connections.get(peer.id);
				if (!state) return;
				state.open = false;
				connections.delete(peer.id);
				for (const listener of state.onClose) listener();
			},
		},
	});
}
