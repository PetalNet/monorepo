import { randomUUID } from "node:crypto";

export interface MatrixConfig {
	readonly homeserver: string;
	readonly accessToken: string;
	readonly ownerBindings: Readonly<Record<string, string>>;
}

export interface MatrixReceipt {
	readonly eventId: string;
	readonly roomId: string;
}

export class MatrixDeliveryError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable: boolean) {
		super(message);
		this.name = "MatrixDeliveryError";
		this.code = code;
		this.retryable = retryable;
	}
}

export interface MatrixTransport {
	assertOwnedTarget(owner: string, target: string): Promise<void>;
	send(owner: string, target: string, body: string, transactionId?: string): Promise<MatrixReceipt>;
}

type MatrixErrorBody = { errcode?: string; error?: string };

/** Minimal Matrix client-server transport for the decided default delivery channel. */
export class HttpMatrixTransport implements MatrixTransport {
	readonly #config: MatrixConfig;
	readonly #fetch: typeof fetch;
	#userId: string | null = null;
	readonly #directRooms = new Map<string, string>();

	constructor(config: MatrixConfig, fetchFn: typeof fetch = fetch) {
		this.#config = config;
		this.#fetch = fetchFn;
	}

	async #request<T>(path: string, init?: RequestInit): Promise<T> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#config.homeserver}${path}`, {
				...init,
				signal: init?.signal ?? AbortSignal.timeout(10_000),
				headers: {
					authorization: `Bearer ${this.#config.accessToken}`,
					accept: "application/json",
					...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
					...init?.headers,
				},
			});
		} catch {
			throw new MatrixDeliveryError("matrix_unreachable", "Matrix homeserver unreachable", true);
		}
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as MatrixErrorBody | null;
			throw new MatrixDeliveryError(
				body?.errcode ?? `matrix_http_${String(response.status)}`,
				body?.error ?? `Matrix returned ${String(response.status)}`,
				response.status === 408 || response.status === 429 || response.status >= 500,
			);
		}
		return (await response.json()) as T;
	}

	async #identity(): Promise<string> {
		if (this.#userId) return this.#userId;
		const result = await this.#request<{ user_id: string }>("/_matrix/client/v3/account/whoami");
		this.#userId = result.user_id;
		return result.user_id;
	}

	async assertOwnedTarget(owner: string, target: string): Promise<void> {
		const boundUser = this.#config.ownerBindings[owner];
		if (!boundUser)
			throw new MatrixDeliveryError(
				"target_not_owned",
				"No verified Matrix identity is bound to this console principal",
				false,
			);
		if (target.startsWith("@")) {
			if (target !== boundUser)
				throw new MatrixDeliveryError(
					"target_not_owned",
					"Matrix user target is not bound to this console principal",
					false,
				);
			return;
		}
		if (!target.startsWith("!"))
			throw new MatrixDeliveryError(
				"invalid_target",
				"Matrix target must be a user id or room id",
				false,
			);
		const joined = await this.#request<{ joined_rooms: string[] }>(
			"/_matrix/client/v3/joined_rooms",
		);
		if (!joined.joined_rooms.includes(target))
			throw new MatrixDeliveryError(
				"target_not_owned",
				"The delivery account is not joined to that room",
				false,
			);
		const membership = await this.#request<{ membership?: string }>(
			`/_matrix/client/v3/rooms/${encodeURIComponent(target)}/state/m.room.member/${encodeURIComponent(boundUser)}`,
		);
		if (membership.membership !== "join")
			throw new MatrixDeliveryError(
				"target_not_owned",
				"The principal's verified Matrix identity is not joined to that room",
				false,
			);
	}

	async #roomForUser(target: string): Promise<string> {
		const cached = this.#directRooms.get(target);
		if (cached) return cached;
		const sender = await this.#identity();
		const direct: Record<string, string[]> = await this.#request<Record<string, string[]>>(
			`/_matrix/client/v3/user/${encodeURIComponent(sender)}/account_data/m.direct`,
		).catch((error: unknown) => {
			if (error instanceof MatrixDeliveryError && error.code === "M_NOT_FOUND") return {};
			throw error;
		});
		const existing = direct[target][0];
		if (existing) {
			this.#directRooms.set(target, existing);
			return existing;
		}
		const created = await this.#request<{ room_id: string }>("/_matrix/client/v3/createRoom", {
			method: "POST",
			body: JSON.stringify({
				is_direct: true,
				preset: "trusted_private_chat",
				...(target === sender ? {} : { invite: [target] }),
			}),
		});
		const next = { ...direct, [target]: [created.room_id] };
		await this.#request<Record<string, never>>(
			`/_matrix/client/v3/user/${encodeURIComponent(sender)}/account_data/m.direct`,
			{ method: "PUT", body: JSON.stringify(next) },
		);
		this.#directRooms.set(target, created.room_id);
		return created.room_id;
	}

	async send(
		owner: string,
		target: string,
		body: string,
		transactionId = randomUUID(),
	): Promise<MatrixReceipt> {
		await this.assertOwnedTarget(owner, target);
		const roomId = target.startsWith("!") ? target : await this.#roomForUser(target);
		const response = await this.#request<{ event_id: string }>(
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
			{
				method: "PUT",
				body: JSON.stringify({ msgtype: "m.text", body }),
			},
		);
		return { eventId: response.event_id, roomId };
	}
}
