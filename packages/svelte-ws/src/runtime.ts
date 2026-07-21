import type { Peer } from "crossws";
import type { NodeAdapter } from "crossws/adapters/node";
import crossws from "crossws/adapters/node";

import type { ConnectionSocket, HandleWebsocket, WebsocketEvent } from "./types.ts";

interface ConnectionState {
	socket: ConnectionSocket;
	onMessage: ((data: Uint8Array) => void)[];
	onClose: (() => void)[];
	/** Frames that arrived before the app handler registered a message listener (async handlers). */
	pendingMessages: Uint8Array[];
	open: boolean;
	/** Set once crossws reports the peer closed, so listeners registered afterwards still fire. */
	closed: boolean;
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
				// The state is registered before any await so frames and closes that race the async
				// handler setup are buffered (messages) or remembered (close) instead of vanishing.
				const state: ConnectionState = {
					onMessage: [],
					onClose: [],
					pendingMessages: [],
					open: true,
					closed: false,
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
							if (event === "message") {
								const listener = handler as (data: Uint8Array) => void;
								state.onMessage.push(listener);
								// Flush frames that arrived before the handler was ready, in arrival order. A
								// connection that already closed delivers nothing: its cleanup has run (or runs
								// via the close branch below) and processing frames for it could only leak.
								if (!state.closed)
									while (state.pendingMessages.length > 0) {
										const data = state.pendingMessages.shift();
										if (data) listener(data);
									}
							} else {
								const listener = handler as () => void;
								state.onClose.push(listener);
								// The peer may have closed while the app handler was still awaiting its setup;
								// fire immediately so late-registered cleanup always runs.
								if (state.closed) listener();
							}
						},
					},
				};
				connections.set(peer.id, state);
				const handle = await loadHandler();
				if (!handle) {
					peer.close(1011, "no websocket handler");
					return;
				}
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
				await handle(event);
			},
			message(peer, message) {
				const state = connections.get(peer.id);
				if (!state) return;
				const data = message.uint8Array();
				if (state.onMessage.length === 0) {
					state.pendingMessages.push(data);
					return;
				}
				for (const listener of state.onMessage) listener(data);
			},
			close(peer) {
				const state = connections.get(peer.id);
				if (!state) return;
				state.open = false;
				state.closed = true;
				state.pendingMessages.length = 0;
				connections.delete(peer.id);
				for (const listener of state.onClose) listener();
			},
		},
	});
}
