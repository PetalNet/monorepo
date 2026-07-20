import { Exit, Schema } from "effect";

import {
	BusClientFrameSchema,
	BusServerFrameSchema,
	OpCallSchema,
	OpResultSchema,
	QueryRequestSchema,
	QueryResultSchema,
	type BusAckFrame,
	type BusClientFrame,
	type BusEventFrame,
	type BusGapFrame,
	type BusHeartbeatFrame,
	type BusResyncFrame,
	type BusServerFrame,
	type BusSubscribeFilter,
	type OpCall,
	type OpResult,
	type QueryRequest,
	type QueryResult,
} from "./schema.js";

const decodeServerFrame = Schema.decodeUnknownExit(BusServerFrameSchema);
const encodeClientFrame = Schema.encodeSync(BusClientFrameSchema);
const decodeOpResult = Schema.decodeUnknownSync(OpResultSchema);
const encodeOpCall = Schema.encodeSync(OpCallSchema);
const decodeQueryResult = Schema.decodeUnknownSync(QueryResultSchema);
const encodeQueryRequest = Schema.encodeSync(QueryRequestSchema);

/** The subset of the WHATWG WebSocket surface the client needs — injectable for tests. */
export interface BusWebSocket {
	send(data: string): void;
	close(): void;
	addEventListener(type: "open", listener: () => void): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "close", listener: () => void): void;
	addEventListener(type: "error", listener: () => void): void;
}

export type BusConnectionState = "connecting" | "open" | "error" | "closed";

export interface BusSubscriptionSpec {
	readonly sub_id: string;
	readonly pattern: string;
	readonly filter?: BusSubscribeFilter;
	readonly since?: number;
}

export interface BusFrameHandlers {
	onFrame?: (frame: BusServerFrame) => void;
	onAck?: (frame: BusAckFrame) => void;
	onEvent?: (frame: BusEventFrame) => void;
	onResync?: (frame: BusResyncFrame) => void;
	onGap?: (frame: BusGapFrame) => void;
	onHeartbeat?: (frame: BusHeartbeatFrame) => void;
	onState?: (state: BusConnectionState) => void;
	/** A frame that failed schema decode — surfaced, never silently coerced. */
	onProtocolError?: (raw: unknown, message: string) => void;
}

export interface BusClientOptions extends BusFrameHandlers {
	readonly url: string;
	/** Socket factory; defaults to the platform WebSocket. */
	readonly webSocket?: (url: string) => BusWebSocket;
	/** Subscriptions (re)established on every (re)connect. */
	readonly subscriptions?: () => readonly BusSubscriptionSpec[];
	/** Reconnect delay in ms; 0 disables reconnection. */
	readonly reconnectDelayMs?: number;
	/** Maximum exponential reconnect delay in ms. */
	readonly reconnectMaxDelayMs?: number;
}

export interface BusClient {
	/** Send a typed subscribe frame on the live connection. */
	subscribe(spec: BusSubscriptionSpec): void;
	/** Send a typed unsubscribe frame on the live connection. */
	unsubscribe(subId: string): void;
	close(): void;
}

const toSubscribeFrame = (spec: BusSubscriptionSpec): BusClientFrame => ({
	schema_version: 1,
	action: "subscribe",
	sub_id: spec.sub_id,
	pattern: spec.pattern,
	...(spec.filter !== undefined ? { filter: spec.filter } : {}),
	...(spec.since !== undefined ? { since: spec.since } : {}),
});

/**
 * Typed client for the console bus WebSocket: every outbound frame is schema-encoded, every inbound
 * frame schema-decoded and dispatched by kind. Reconnects with the caller's current subscription
 * set, so `since`-based healing composes with `resync_required`.
 */
export function connectBusClient(options: BusClientOptions): BusClient {
	const factory =
		options.webSocket ?? ((url: string) => new WebSocket(url) as unknown as BusWebSocket);
	const reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
	let disposed = false;
	let socket: BusWebSocket | undefined;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;
	let hasOpened = false;
	const lastSeq = new Map<string, number>();
	const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
	const healingSpec = (spec: BusSubscriptionSpec): BusSubscriptionSpec => {
		const seen = lastSeq.get(spec.sub_id);
		if (!hasOpened || seen === undefined) return spec;
		return { ...spec, since: Math.max(spec.since ?? 0, seen) };
	};

	const sendFrame = (frame: BusClientFrame): void => {
		socket?.send(JSON.stringify(encodeClientFrame(frame)));
	};

	const connect = (): void => {
		options.onState?.("connecting");
		socket = factory(options.url);
		socket.addEventListener("open", () => {
			options.onState?.("open");
			for (const spec of options.subscriptions?.() ?? [])
				sendFrame(toSubscribeFrame(healingSpec(spec)));
			hasOpened = true;
		});
		socket.addEventListener("message", ({ data }) => {
			let raw: unknown;
			try {
				raw = JSON.parse(String(data));
			} catch {
				options.onProtocolError?.(data, "frame is not JSON");
				return;
			}
			const decoded = decodeServerFrame(raw);
			if (Exit.isFailure(decoded)) {
				options.onProtocolError?.(raw, String(decoded.cause));
				return;
			}
			const frame = decoded.value;
			reconnectAttempt = 0;
			if (frame.kind === "event") lastSeq.set(frame.sub_id, frame.seq);
			options.onFrame?.(frame);
			switch (frame.kind) {
				case "ack":
					options.onAck?.(frame);
					break;
				case "event":
					options.onEvent?.(frame);
					break;
				case "resync_required":
					options.onResync?.(frame);
					break;
				case "gap":
					options.onGap?.(frame);
					break;
				case "heartbeat":
					options.onHeartbeat?.(frame);
					break;
			}
		});
		socket.addEventListener("error", () => {
			options.onState?.("error");
		});
		socket.addEventListener("close", () => {
			options.onState?.("closed");
			if (!disposed && reconnectDelayMs > 0) {
				const base = Math.min(reconnectMaxDelayMs, reconnectDelayMs * 2 ** reconnectAttempt);
				reconnectAttempt += 1;
				const delay = Math.max(1, Math.round(base * (0.5 + Math.random())));
				reconnect = setTimeout(connect, delay);
			}
		});
	};
	connect();

	return {
		subscribe(spec) {
			sendFrame(toSubscribeFrame(spec));
		},
		unsubscribe(subId) {
			sendFrame({ schema_version: 1, action: "unsubscribe", sub_id: subId });
		},
		close() {
			disposed = true;
			if (reconnect) clearTimeout(reconnect);
			socket?.close();
		},
	};
}

/** Minimal fetch signature so the REST clients run in browsers, Node, and tests unchanged. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ json(): Promise<unknown> }>;

/** Typed command-plane call: encodes the OpCall, decodes the OpResult envelope. */
export async function executeOpCall(
	fetchLike: FetchLike,
	baseUrl: string,
	call: OpCall,
	headers: Record<string, string> = {},
): Promise<OpResult> {
	const response = await fetchLike(`${baseUrl}/api/v1/op`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(encodeOpCall(call)),
	});
	return decodeOpResult(await response.json());
}

/** Typed query-plane call: encodes the QueryRequest, decodes the QueryResult. */
export async function executeQuery(
	fetchLike: FetchLike,
	baseUrl: string,
	request: QueryRequest,
	headers: Record<string, string> = {},
): Promise<QueryResult> {
	const response = await fetchLike(`${baseUrl}/api/v1/query`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(encodeQueryRequest(request)),
	});
	return decodeQueryResult(await response.json());
}
