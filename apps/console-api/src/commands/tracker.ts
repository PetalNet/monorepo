const MAX_RESPONSE_BYTES = 64 * 1024;

export class TrackerCommandError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.name = "TrackerCommandError";
		this.code = code;
		this.retryable = retryable;
	}
}

export interface TrackerCommandOptions {
	readonly url: string;
	readonly token: string;
	readonly timeoutMs?: number;
}

export interface TrackerClaimInput {
	readonly taskId: number;
	readonly capability?: string;
}

export interface TrackerClaimResult {
	readonly task_id: number;
	readonly status: "doing";
}

/**
 * Narrow command adapter for the tracker's canonical bearer-authenticated RPC. The tracker owns the
 * todo -> doing CAS and lease secret; console-api deliberately returns only browser-safe proof.
 */
export class TrackerCommandWriter {
	readonly #url: string;
	readonly #token: string;
	readonly #timeoutMs: number;

	constructor(options: TrackerCommandOptions) {
		this.#url = options.url;
		this.#token = options.token;
		this.#timeoutMs = options.timeoutMs ?? 5_000;
	}

	async claim(input: TrackerClaimInput): Promise<TrackerClaimResult> {
		let response: Response;
		try {
			response = await fetch(this.#url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.#token}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify({
					op: "claim",
					args: {
						id: input.taskId,
						...(input.capability ? { capability: input.capability } : {}),
					},
				}),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch {
			throw new TrackerCommandError(
				"tracker_unavailable",
				"tracker command writer is unavailable",
				true,
			);
		}
		if (!response.ok)
			throw new TrackerCommandError(
				"tracker_unavailable",
				"tracker rejected the claim request",
				response.status >= 500 || response.status === 429,
			);
		let wire: unknown;
		try {
			const body = await response.text();
			if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("oversized response");
			wire = JSON.parse(body);
		} catch {
			throw new TrackerCommandError(
				"tracker_unavailable",
				"tracker returned an invalid claim response",
				true,
			);
		}
		const claimed = (wire as { claimed?: { id?: unknown; status?: unknown } | null })?.claimed;
		if (!claimed || claimed.id !== input.taskId)
			throw new TrackerCommandError("claim_lost", "the task was claimed by another resident first");
		if (claimed.status !== "doing")
			throw new TrackerCommandError(
				"tracker_unavailable",
				"tracker returned an invalid claimed task state",
				true,
			);
		return { task_id: input.taskId, status: "doing" };
	}
}
