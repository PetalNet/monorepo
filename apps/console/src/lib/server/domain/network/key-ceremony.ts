export type KeyCeremonyResult = {
	readonly pubkey_fp: string;
	readonly handle: string | null;
	readonly state: "enrolled" | "denied" | "revoked";
	readonly applied_at: string;
};

export class KeyCeremonyError extends Error {
	readonly _tag = "KeyCeremonyError";
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable: boolean) {
		super(message);
		this.name = "KeyCeremonyError";
		this.code = code;
		this.retryable = retryable;
	}
}

interface CeremonyResponse {
	readonly ok?: boolean;
	readonly result?: KeyCeremonyResult;
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
		readonly retryable?: boolean;
	};
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Private doorman-edge administration seam. The edge remains the source of truth: console-api never
 * edits its projected registry to simulate an enrollment. The deployment endpoint must perform the
 * key mutation durably and emit the matching edge lifecycle event.
 */
export class DoormanKeyCeremonyClient {
	readonly #base: URL;
	readonly #token: string;
	readonly #fetch: Fetch;

	constructor(options: { readonly url: string; readonly token: string; readonly fetch?: Fetch }) {
		this.#base = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`);
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
	}

	async health(): Promise<boolean> {
		try {
			const response = await this.#request("health", undefined, 2_000);
			const payload = (await response.json().catch(() => null)) as { readonly ok?: boolean } | null;
			return response.ok && payload?.ok === true;
		} catch {
			return false;
		}
	}

	approve(input: {
		readonly requestId: string;
		readonly pubkeyFp: string;
		readonly handle: string;
		readonly principal: string;
	}): Promise<KeyCeremonyResult> {
		return this.#mutate(
			"approve",
			{
				request_id: input.requestId,
				pubkey_fp: input.pubkeyFp,
				handle: input.handle,
				principal: input.principal,
			},
			input.pubkeyFp,
			"enrolled",
			input.handle,
		);
	}

	deny(input: {
		readonly requestId: string;
		readonly pubkeyFp: string;
		readonly reason: string;
		readonly principal: string;
	}): Promise<KeyCeremonyResult> {
		return this.#mutate(
			"deny",
			{
				request_id: input.requestId,
				pubkey_fp: input.pubkeyFp,
				reason: input.reason,
				principal: input.principal,
			},
			input.pubkeyFp,
			"denied",
			null,
		);
	}

	revoke(input: {
		readonly requestId: string;
		readonly pubkeyFp: string;
		readonly handle: string;
		readonly reason: string;
		readonly principal: string;
	}): Promise<KeyCeremonyResult> {
		return this.#mutate(
			"revoke",
			{
				request_id: input.requestId,
				pubkey_fp: input.pubkeyFp,
				handle: input.handle,
				reason: input.reason,
				principal: input.principal,
			},
			input.pubkeyFp,
			"revoked",
			input.handle,
		);
	}

	async #mutate(
		action: "approve" | "deny" | "revoke",
		body: Record<string, string>,
		expectedFingerprint: string,
		expectedState: KeyCeremonyResult["state"],
		expectedHandle: string | null,
	) {
		const response = await this.#request(action, body, 8_000);
		const payload = (await response.json().catch(() => null)) as CeremonyResponse | null;
		if (!response.ok || !payload?.ok || !payload.result) {
			throw new KeyCeremonyError(
				payload?.error?.code ?? "doorman_rejected",
				payload?.error?.message ?? `Doorman rejected key ceremony (${String(response.status)})`,
				payload?.error?.retryable ?? response.status >= 500,
			);
		}
		const result = payload.result;
		if (
			result.pubkey_fp !== expectedFingerprint ||
			result.state !== expectedState ||
			result.handle !== expectedHandle ||
			!Number.isFinite(Date.parse(result.applied_at))
		) {
			throw new KeyCeremonyError(
				"doorman_invalid_result",
				"Doorman returned a result that does not match the requested key ceremony",
				false,
			);
		}
		return result;
	}

	#request(action: string, body: Record<string, string> | undefined, timeoutMs: number) {
		return this.#fetch(new URL(action, this.#base), {
			method: body ? "POST" : "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${this.#token}`,
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	}
}
