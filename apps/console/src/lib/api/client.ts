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

import type { ApiError, Me, OpResult } from "./types";

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

/** GET /api/v1/me — the caller's Principal + display/grant name (session chip). */
export async function readMe(fetchFn: typeof fetch = fetch): Promise<Me> {
	const res = await fetchFn(`${base()}/me`, { headers: { accept: "application/json" } });
	return json<Me>(res);
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
		body: JSON.stringify({ op, id, args, dry_run: opts.dry_run ?? false }),
	});
	return json<OpResult>(res);
}
