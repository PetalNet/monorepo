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
	ApiError,
	BoxUpdateItem,
	BoxUpdateRaw,
	CatalogEntry,
	DashboardItem,
	ExecutorItem,
	EdgeRegistryItem,
	EdgeSessionItem,
	Me,
	OpResult,
	ReadEnvelope,
	QueryResult,
	StructuredQuery,
} from "./types";

export type DataMode = "mock" | "live";

export function dataMode(): DataMode {
	return env.PUBLIC_CONSOLE_DATA_MODE === "live" ? "live" : "mock";
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
			err = (await res.json()) as ApiError;
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
		// Mock: validate + audit locally, echo an applied result. No effect.
		return {
			ok: true,
			status: "applied",
			result: { op, args, mock: true },
			undo: null,
			audit_seq: null,
		};
	}
	const id = crypto.randomUUID();
	const res = await (opts.fetchFn ?? fetch)(`${base()}/op`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		credentials: "include", // send the Authentik session for command authz (§1.2)
		body: JSON.stringify({ op, id, args, dry_run: opts.dry_run ?? false }),
	});
	return json<OpResult>(res);
}
