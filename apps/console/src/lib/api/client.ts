/**
 * The four-plane console-api client (CONSOLE-CONTRACTS.md §1): Query, Command, Bus, Library. Thin
 * typed reads/calls — never a re-implementation. Two modes:
 *
 * - Mock : contract-shaped fixtures, no backend (default until the API is up)
 * - Live : talks to PUBLIC_CONSOLE_API_BASE
 *
 * The shell wires `/me` (session chip) and the op plane; typed entity reads (`readEntity`) land
 * with the first surface that reads live, against the documented schema — never a divergent
 * invented shape (gaps go to BLOCKERS.md).
 */
import { env } from "$env/dynamic/public";

import { flattenRosterItem, type JoinedRosterItem } from "./derive";
import type {
	AttentionItem,
	ApiError,
	BoxUpdateItem,
	BoxUpdateRaw,
	CatalogEntry,
	CardItem,
	ConsoleHealth,
	DashboardItem,
	ExecutorItem,
	HeartbeatItem,
	GovernanceItem,
	GovernancePool,
	LeaseItem,
	EdgeSessionItem,
	Me,
	OpResult,
	ReadEnvelope,
	QueryResult,
	RegistryItem,
	RosterItem,
	StructuredQuery,
	SubscriptionItem,
	TaskItem,
	WorkerItem,
} from "./types";

export type DataMode = "mock" | "live";

export function dataMode(): DataMode {
	return env.PUBLIC_CONSOLE_DATA_MODE === "live" ? "live" : "mock";
}

function busWebSocketUrl(): string {
	return `${base().replace(/^http/, "ws")}/bus/ws`;
}

export interface BusSubscription {
	readonly sub_id: string;
	readonly pattern: string;
	readonly filter?: Record<string, string>;
	readonly since?: number;
}

export type BusConnectionState = "connecting" | "open" | "error" | "closed";

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
	| {
			schema_version: 1;
			stream_id: string;
			kind: "snapshot";
			seq: number;
			data_b64: string;
	  }
	| {
			schema_version: 1;
			stream_id: string;
			kind: "error";
			seq: number;
			code: string;
	  };

/**
 * Browser bus transport. WebSocket handshakes carry the host-only Better Auth cookie to the
 * same-origin console-api, which validates the session directly. Resolve subscriptions lazily so
 * reconnects can resume from the latest sequence observed by the caller.
 */
export function connectBus(
	subscriptions: () => readonly BusSubscription[],
	onFrame: (frame: Record<string, unknown>) => void,
	onState: (state: BusConnectionState) => void = () => {},
): () => void {
	let disposed = false;
	let socket: WebSocket | null = null;
	let reconnect: ReturnType<typeof setTimeout> | null = null;
	const connect = () => {
		onState("connecting");
		socket = new WebSocket(busWebSocketUrl());
		socket.addEventListener("open", () => {
			onState("open");
			for (const subscription of subscriptions())
				socket?.send(
					JSON.stringify({
						schema_version: 1,
						action: "subscribe",
						...subscription,
					}),
				);
		});
		socket.addEventListener("message", (message) => {
			try {
				const frame = JSON.parse(String(message.data)) as unknown;
				if (frame && typeof frame === "object" && !Array.isArray(frame))
					onFrame(frame as Record<string, unknown>);
			} catch {
				onState("error");
			}
		});
		socket.addEventListener("error", () => onState("error"));
		socket.addEventListener("close", () => {
			onState("closed");
			if (!disposed) reconnect = setTimeout(connect, 2000);
		});
	};
	connect();
	return () => {
		disposed = true;
		if (reconnect) clearTimeout(reconnect);
		socket?.close();
	};
}

function base(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "/api/console/v1";
}

class ConsoleApiError extends Error {
	code: string;
	retryable: boolean;
	constructor(e: ApiError) {
		super(e.message);
		this.name = "ConsoleApiError";
		this.code = e.code;
		this.retryable = e.retryable;
	}
}

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) {
		let err: ApiError = {
			code: "http_error",
			message: `${res.status}`,
			retryable: res.status >= 500,
		};
		try {
			const body = (await res.json()) as ApiError | { error?: ApiError };
			err = "error" in body && body.error ? body.error : (body as ApiError);
		} catch {
			/* non-JSON error body */
		}
		throw new ConsoleApiError(err);
	}
	return (await res.json()) as T;
}

/**
 * GET /api/v1/me — the caller's Principal + display/grant name (session chip). `credentials:
 * "include"` sends the Better Auth session cookie to same-origin console-api; without it the API
 * cannot validate the caller. The API side owns the matching exact-origin credentialed CORS.
 */
export async function readMe(fetchFn: typeof fetch = fetch): Promise<Me> {
	const res = await fetchFn(`${base()}/me`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<Me>(res);
}

/** GET /api/v1/box-updates — contract-backed update/security posture for every visible box. */
export async function readBoxUpdates(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<BoxUpdateItem>> {
	const res = await fetchFn(`${base()}/box-updates?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<BoxUpdateItem>>(res);
}

/** GET /api/v1/box-updates/{box_id}/raw — pending packages and CVE detail. */
export async function readBoxUpdateRaw(
	boxId: string,
	fetchFn: typeof fetch = fetch,
): Promise<BoxUpdateRaw> {
	const res = await fetchFn(`${base()}/box-updates/${encodeURIComponent(boxId)}/raw`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<BoxUpdateRaw>(res);
}

/** GET /api/v1/executors — positive liveness evidence used to gate named operations. */
export async function readExecutors(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<ExecutorItem>> {
	const res = await fetchFn(`${base()}/executors`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<ExecutorItem>>(res);
}

/** Authoritative server gate. A denied response is retained before console-api returns 403. */
export async function readTerminalAccess(fetchFn: typeof fetch = fetch): Promise<TerminalAccess> {
	const res = await fetchFn(`${base()}/terminal`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<TerminalAccess>(res);
}

/**
 * Audit-before-first-frame terminal transport. The returned disposer aborts the streaming fetch;
 * callers should also invoke terminalDetach when they intentionally close an established stream.
 */
export function connectTerminal(
	target: {
		host: string;
		tmux_session: string;
		pane_id: string;
		scrollback_lines?: number;
	},
	onFrame: (frame: TerminalFrame) => void,
	onError: (error: Error) => void,
): () => void {
	const controller = new AbortController();
	void (async () => {
		try {
			const res = await fetch(`${base()}/terminal/streams`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/x-ndjson",
				},
				credentials: "include",
				body: JSON.stringify(target),
				signal: controller.signal,
			});
			if (!res.ok) await json<never>(res);
			if (!res.body) throw new Error("terminal response has no frame stream");
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let pending = "";
			for (;;) {
				// Stream reads are ordered and each read advances the same reader.
				// oxlint-disable-next-line no-await-in-loop
				const { done, value } = await reader.read();
				pending += decoder.decode(value, { stream: !done });
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					if (!line) continue;
					onFrame(JSON.parse(line) as TerminalFrame);
				}
				if (done) break;
			}
		} catch (error) {
			if (!controller.signal.aborted)
				onError(error instanceof Error ? error : new Error("terminal stream failed"));
		}
	})();
	return () => controller.abort();
}

async function terminalMutation<T>(streamId: string, action: string, body?: unknown): Promise<T> {
	const res = await fetch(`${base()}/terminal/streams/${encodeURIComponent(streamId)}/${action}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		credentials: "include",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return json<T>(res);
}

export async function terminalAttach(streamId: string): Promise<void> {
	await terminalMutation(streamId, "attach");
}

export async function terminalInput(streamId: string, data: Uint8Array): Promise<void> {
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	await terminalMutation(streamId, "input", { data_b64: btoa(binary) });
}

export async function terminalDetach(streamId: string): Promise<void> {
	await terminalMutation(streamId, "detach");
}
export async function readHeartbeats(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<HeartbeatItem>> {
	const res = await fetchFn(`${base()}/heartbeats?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<HeartbeatItem>>(res);
}
export async function readGovernance(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<GovernanceItem> & { pool?: GovernancePool }> {
	const res = await fetchFn(`${base()}/governance?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<GovernanceItem> & { pool?: GovernancePool }>(res);
}

export async function readRoster(fetchFn: typeof fetch = fetch): Promise<ReadEnvelope<RosterItem>> {
	const res = await fetchFn(`${base()}/roster`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	const envelope = await json<ReadEnvelope<JoinedRosterItem>>(res);
	return { ...envelope, items: envelope.items.map(flattenRosterItem) };
}

export async function readRegistry(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<RegistryItem>> {
	const res = await fetchFn(`${base()}/registry?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<RegistryItem>>(res);
}

export async function readWorkers(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<WorkerItem>> {
	const res = await fetchFn(`${base()}/workers?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<WorkerItem>>(res);
}
export async function readTasks(fetchFn: typeof fetch = fetch): Promise<ReadEnvelope<TaskItem>> {
	let cursor: string | null = null;
	let first: ReadEnvelope<TaskItem> | null = null;
	const items: TaskItem[] = [];
	do {
		// Cursor pagination is sequential: each request depends on the previous cursor.
		// oxlint-disable-next-line no-await-in-loop
		const res: Response = await fetchFn(
			`${base()}/tasks?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			{
				headers: { accept: "application/json" },
				credentials: "include",
			},
		);
		// oxlint-disable-next-line no-await-in-loop
		const page: ReadEnvelope<TaskItem> = await json<ReadEnvelope<TaskItem>>(res);
		first ??= page;
		items.push(...page.items);
		cursor = page.next_cursor;
	} while (cursor);
	return {
		...(first as ReadEnvelope<TaskItem>),
		items,
		next_cursor: null,
		total: first?.total ?? items.length,
	};
}
export async function readLeases(fetchFn: typeof fetch = fetch): Promise<ReadEnvelope<LeaseItem>> {
	const res = await fetchFn(`${base()}/leases?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<LeaseItem>>(res);
}

/** POST /api/v1/query — scope-filtered structured statistics query, run as the caller. */
export async function runQuery(
	request: StructuredQuery,
	fetchFn: typeof fetch = fetch,
): Promise<QueryResult> {
	const res = await fetchFn(`${base()}/query`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		credentials: "include",
		body: JSON.stringify(request),
	});
	return json<QueryResult>(res);
}

/** GET /api/v1/catalog — readable, scope-filtered semantic catalog. */
export async function readCatalog(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<CatalogEntry>> {
	const res = await fetchFn(`${base()}/catalog?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<CatalogEntry>>(res);
}

/** GET /api/v1/dashboards — Library-backed dashboard list projection. */
export async function readDashboards(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<DashboardItem>> {
	const res = await fetchFn(`${base()}/dashboards?limit=100`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<DashboardItem>>(res);
}

export async function readEdgeSessions(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<EdgeSessionItem>> {
	const res = await fetchFn(`${base()}/edge/sessions?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<EdgeSessionItem>>(res);
}

export async function readSubscriptions(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<SubscriptionItem>> {
	const res = await fetchFn(`${base()}/subscriptions?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<SubscriptionItem>>(res);
}
export async function readCards(fetchFn: typeof fetch = fetch): Promise<ReadEnvelope<CardItem>> {
	const res = await fetchFn(`${base()}/cards?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<CardItem>>(res);
}
export async function readAttention(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<AttentionItem>> {
	const res = await fetchFn(`${base()}/attention?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<AttentionItem>>(res);
}
export async function readHealth(fetchFn: typeof fetch = fetch): Promise<ConsoleHealth> {
	const res = await fetchFn(`${base()}/health`, {
		headers: { accept: "application/json" },
	});
	return json<ConsoleHealth>(res);
}

export interface AssistantContextPayload {
	element_kind: string;
	field?: string;
	value: string;
	datum?: Record<string, unknown>;
	query_ref?: string;
	entity_ref?: string;
}

export interface AssistantMessageResult {
	schema_version: 1;
	session_id: string;
	message_id: string;
	content: string;
	tool_results: unknown[];
}

export interface AssistantSessionResult {
	schema_version: 1;
	session: {
		session_id: string | null;
		state: string;
		window_layout: unknown;
		last_context: AssistantContextPayload | null;
	} | null;
}

/** Restore the caller-scoped assistant window and selected context. */
export async function getAssistantSession(
	fetchFn: typeof fetch = fetch,
): Promise<AssistantSessionResult> {
	const res = await fetchFn(`${base()}/assistant/session`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<AssistantSessionResult>(res);
}

/** Deliver selected UI context through the caller-scoped assistant runtime. */
export async function sendAssistantContext(
	payload: AssistantContextPayload,
	fetchFn: typeof fetch = fetch,
): Promise<AssistantMessageResult> {
	const res = await fetchFn(`${base()}/assistant/context`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		credentials: "include",
		body: JSON.stringify({ id: crypto.randomUUID(), payload }),
	});
	return json<AssistantMessageResult>(res);
}

/** Continue the principal's durable, per-user manager session. */
export async function sendAssistantMessage(
	message: string,
	fetchFn: typeof fetch = fetch,
): Promise<AssistantMessageResult> {
	const res = await fetchFn(`${base()}/assistant/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		credentials: "include",
		body: JSON.stringify({ id: crypto.randomUUID(), message }),
	});
	return json<AssistantMessageResult>(res);
}

/**
 * POST /api/v1/op — the named-op command plane (§5.1). Every mutation is a named op, identical for
 * humans and agents. `id` is a client-minted UUID for idempotent dedup. Browsers never hold a
 * claim_token (§5.1): human principals use force:true on lease-guarded writes.
 */
export async function runOp(
	op: string,
	args: Record<string, unknown>,
	opts: { dry_run?: boolean; fetchFn?: typeof fetch } = {},
): Promise<OpResult> {
	if (dataMode() === "mock") {
		throw new Error("Commands are unavailable in mock data mode; no operation was applied.");
	}
	const id = crypto.randomUUID();
	const res = await (opts.fetchFn ?? fetch)(`${base()}/op`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		credentials: "include", // send the Better Auth session for command authz (§1.2)
		body: JSON.stringify({
			schema_version: 1,
			op,
			id,
			args,
			dry_run: opts.dry_run ?? false,
		}),
	});
	return json<OpResult>(res);
}
