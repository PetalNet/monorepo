import type {
	BoxUpdateRaw,
	ConsoleHealth,
	Me,
	OpResult,
	ReadEnvelope,
	RosterItem,
	StructuredQuery,
} from "$lib/api/types";
import type { ReadPlane, ReadPlaneResult } from "$lib/operations.remote";
import {
	executeNamedOp,
	getAssistantSessionRemote,
	runStructuredQuery,
	sendAssistantRemote,
} from "$lib/operations.remote";
import { readPlane } from "$lib/rpc/read-plane";
import type { QueryResult } from "$lib/server/domain/query/structured";
import { Effect } from "effect";

export type DataMode = "mock" | "live";
export const dataMode = (): DataMode => "live";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);
const read = <P extends ReadPlane>(plane: P): Promise<ReadPlaneResult[P]> => run(readPlane(plane));

export const readMe = (_fetch?: typeof fetch): Promise<Me> => read("me");
export const readHealth = (_fetch?: typeof fetch): Promise<ConsoleHealth> => read("health");
export const readRoster = (_fetch?: typeof fetch): Promise<ReadEnvelope<RosterItem>> =>
	read("roster");
export const readHeartbeats = (_fetch?: typeof fetch) => read("heartbeats");
export const readGovernance = (_fetch?: typeof fetch) => read("governance");
export const readBoxUpdates = (_fetch?: typeof fetch) => read("box-updates");
export const readExecutors = (_fetch?: typeof fetch) => read("executors");
export const readRegistry = (_fetch?: typeof fetch) => read("registry");
export const readWorkers = (_fetch?: typeof fetch) => read("workers");
export const readTasks = (_fetch?: typeof fetch) => read("tasks");
export const readLeases = (_fetch?: typeof fetch) => read("leases");
export const readCatalog = (_fetch?: typeof fetch) => read("catalog");
export const readDashboards = (_fetch?: typeof fetch) => read("dashboards");
export const readEdgeSessions = (_fetch?: typeof fetch) => read("edge-sessions");
export const readSubscriptions = (_fetch?: typeof fetch) => read("subscriptions");
export const readCards = (_fetch?: typeof fetch) => read("cards");
export const readAttention = (_fetch?: typeof fetch) => read("attention");

export const runQuery = (request: StructuredQuery, _fetch?: typeof fetch): Promise<QueryResult> =>
	run(runStructuredQuery(request));

export const runOp = (
	op: string,
	args: Record<string, unknown>,
	opts: { dry_run?: boolean; fetchFn?: typeof fetch } = {},
): Promise<OpResult> => run(executeNamedOp({ op, args, dry_run: opts.dry_run }));

export interface BusSubscription {
	readonly sub_id: string;
	readonly pattern: string;
	readonly filter?: Record<string, string>;
	readonly since?: number;
}
export type BusConnectionState = "connecting" | "open" | "error" | "closed";

function socketUrl(path: string): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}${path}`;
}

export function connectBus(
	subscriptions: () => readonly BusSubscription[],
	onFrame: (frame: Record<string, unknown>) => void,
	onState: (state: BusConnectionState) => void = () => {},
): () => void {
	let disposed = false;
	let socket: WebSocket | undefined;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	const connect = () => {
		onState("connecting");
		socket = new WebSocket(socketUrl("/api/v1/bus/ws"));
		socket.addEventListener("open", () => {
			onState("open");
			for (const subscription of subscriptions())
				socket?.send(JSON.stringify({ schema_version: 1, action: "subscribe", ...subscription }));
		});
		socket.addEventListener("message", ({ data }) => {
			try {
				const frame = JSON.parse(String(data)) as unknown;
				if (frame && typeof frame === "object" && !Array.isArray(frame))
					onFrame(frame as Record<string, unknown>);
			} catch {
				onState("error");
			}
		});
		socket.addEventListener("error", () => {
			onState("error");
		});
		socket.addEventListener("close", () => {
			onState("closed");
			if (!disposed) reconnect = setTimeout(connect, 2_000);
		});
	};
	connect();
	return () => {
		disposed = true;
		if (reconnect) clearTimeout(reconnect);
		socket?.close();
	};
}

export interface TerminalAccess {
	readonly audit_writable: boolean;
	readonly pty_live: boolean;
	readonly audit_seq: number;
}
export type TerminalFrame =
	| {
			schema_version: 1;
			stream_id: string;
			kind: "open";
			seq: number;
			audit_seq: number;
			mode: "read";
	  }
	| { schema_version: 1; stream_id: string; kind: "snapshot"; seq: number; data_b64: string }
	| { schema_version: 1; stream_id: string; kind: "error"; seq: number; code: string };

export async function readTerminalAccess(_fetch?: typeof fetch): Promise<TerminalAccess> {
	const me = await readMe();
	return { audit_writable: true, pty_live: me.lanes.includes("term_admin"), audit_seq: 0 };
}

export function connectTerminal(
	target: Record<string, unknown>,
	onFrame: (frame: TerminalFrame) => void,
	onError: (error: Error) => void,
): () => void {
	const socket = new WebSocket(socketUrl("/api/v1/terminal/ws"));
	socket.addEventListener("open", () => {
		socket.send(JSON.stringify({ action: "open", ...target }));
	});
	socket.addEventListener("message", ({ data }) => {
		onFrame(JSON.parse(String(data)) as TerminalFrame);
	});
	socket.addEventListener("error", () => {
		onError(new Error("Terminal stream is unavailable"));
	});
	return () => {
		socket.close();
	};
}

const terminalMutation = async (streamId: string, action: string, data?: unknown) => {
	const socket = new WebSocket(socketUrl("/api/v1/terminal/ws"));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({ stream_id: streamId, action, data }));
			socket.close();
			resolve();
		});
		socket.addEventListener("error", () => {
			reject(new Error("Terminal command is unavailable"));
		});
	});
};
export const terminalAttach = (streamId: string) => terminalMutation(streamId, "attach");
export const terminalDetach = (streamId: string) => terminalMutation(streamId, "detach");
export const terminalInput = (streamId: string, data: Uint8Array) =>
	terminalMutation(streamId, "input", Array.from(data));

export async function readBoxUpdateRaw(
	boxId: string,
	_fetch?: typeof fetch,
): Promise<BoxUpdateRaw> {
	const updates = await readBoxUpdates();
	const item = updates.items.find((candidate) => candidate.box_id === boxId);
	if (!item) throw new Error(`No visible update record for ${boxId}`);
	return item as unknown as BoxUpdateRaw;
}

export interface AssistantContextPayload {
	element_kind: string;
	field?: string;
	value: string;
	datum?: Record<string, unknown>;
	query_ref?: string;
	entity_ref?: string;
}
export const getAssistantSession = () => run(getAssistantSessionRemote());
export const sendAssistantMessage = (message: string) =>
	run(sendAssistantRemote({ kind: "user", content: message }));
export const sendAssistantContext = (payload: AssistantContextPayload) =>
	run(sendAssistantRemote({ kind: "context", content: JSON.stringify(payload) }));
