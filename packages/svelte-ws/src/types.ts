import type { Peer } from "crossws";

export type WebsocketProtocol = "ws" | "wss";

/**
 * Per-connection socket handed to the app handler. A thin event seam over a crossws Peer: crossws
 * dispatches message/close through adapter-level hooks, and the runtime fans them back out to the
 * connection that owns them.
 */
export interface ConnectionSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
	isOpen(): boolean;
	on(event: "message", handler: (data: Uint8Array) => void): void;
	on(event: "close", handler: () => void): void;
}

export interface WebsocketEvent {
	socket: ConnectionSocket;
	peer: Peer;
	request: {
		url: Readonly<URL>;
		headers: Headers;
		protocol: WebsocketProtocol;
	};
	locals: Record<string, unknown>;
}

export type HandleWebsocket = (event: WebsocketEvent) => void | Promise<void>;

export interface RouteModule {
	handleWebsocket?: HandleWebsocket;
}
