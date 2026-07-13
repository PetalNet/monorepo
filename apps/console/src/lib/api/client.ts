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

import type {
	AttentionItem,
	ApiError,
	BoxUpdateItem,
	BoxUpdateRaw,
	CatalogEntry,
	CardItem,
	ConsoleHealth,
	DashboardItem,
	DeliveryItem,
	ExecutorItem,
	HeartbeatItem,
	GovernanceItem,
	GovernancePool,
	LeaseItem,
	EdgeRegistryItem,
	EdgeSessionItem,
	Me,
	OpResult,
	ReadEnvelope,
	QueryResult,
	StructuredQuery,
	SubscriptionItem,
	TaskItem,
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

/**
 * Browser bus transport. WebSocket handshakes use the browser's credential mode, so the trusted
 * Authentik cookie reaches the console proxy and the proxy stamps the upgrade identity. Resolve
 * subscriptions lazily so reconnects can resume from the latest sequence observed by the caller.
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
				socket?.send(JSON.stringify({ schema_version: 1, action: "subscribe", ...subscription }));
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
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
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
 * "include"` so the browser sends the Authentik session cookie to console-api even cross-origin
 * (the human forwardAuth flow, §1.2); without it a cross-origin console-api never sees the session
 * and every human falls to the offline principal. The API side owns the matching credentialed CORS
 * (BLOCKERS).
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

export async function readEdgeRegistry(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<EdgeRegistryItem>> {
	const res = await fetchFn(`${base()}/edge/registry?limit=1000`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<EdgeRegistryItem>>(res);
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
export async function readDelivery(
	fetchFn: typeof fetch = fetch,
): Promise<ReadEnvelope<DeliveryItem>> {
	const res = await fetchFn(`${base()}/delivery?limit=10`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	return json<ReadEnvelope<DeliveryItem>>(res);
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
	const res = await fetchFn(`${base()}/health`, { headers: { accept: "application/json" } });
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
		credentials: "include", // send the Authentik session for command authz (§1.2)
		body: JSON.stringify({ schema_version: 1, op, id, args, dry_run: opts.dry_run ?? false }),
	});
	return json<OpResult>(res);
}
