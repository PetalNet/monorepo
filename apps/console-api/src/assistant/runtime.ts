import { createHash, randomBytes } from "node:crypto";

import type { Principal } from "../auth/principal.ts";
import { sha256 } from "../auth/principal.ts";
import type { Sql } from "../db/pool.ts";
import { scrubUnknown } from "../ingest/scrubber.ts";

const MAX_MANAGER_RESPONSE_BYTES = 256 * 1024;
const STALE_MESSAGE_MS = 60_000;

export class AssistantRuntimeError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.code = code;
		this.retryable = retryable;
	}
}

export interface AssistantManagerOptions {
	url: string;
	token: string;
	publicConsoleUrl: string;
	timeoutMs?: number;
}

export interface AssistantMessageResult {
	schema_version: 1;
	session_id: string;
	message_id: string;
	content: string;
	tool_results: unknown[];
}

export class ClaudeCodeAssistantManager {
	readonly #url: string;
	readonly #token: string;
	readonly #publicConsoleUrl: string;
	readonly #timeoutMs: number;

	constructor(options: AssistantManagerOptions) {
		this.#url = options.url.replace(/\/$/, "");
		this.#token = options.token;
		this.#publicConsoleUrl = options.publicConsoleUrl.replace(/\/$/, "");
		this.#timeoutMs = options.timeoutMs ?? 60_000;
	}

	async #post(
		path: string,
		body: unknown,
		notFoundIsNull = false,
	): Promise<Record<string, unknown> | null> {
		let response: Response;
		try {
			response = await fetch(`${this.#url}${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch {
			throw new AssistantRuntimeError(
				"assistant_manager_unavailable",
				"dashboard assistant manager is unavailable",
				true,
			);
		}
		if (notFoundIsNull && response.status === 404) return null;
		if (!response.ok)
			throw new AssistantRuntimeError(
				"assistant_manager_unavailable",
				"dashboard assistant manager rejected the request",
				response.status >= 500 || response.status === 429,
			);
		const text = await response.text();
		if (Buffer.byteLength(text) > MAX_MANAGER_RESPONSE_BYTES)
			throw new AssistantRuntimeError("assistant_manager_invalid", "manager response is too large");
		try {
			const value = JSON.parse(text) as unknown;
			if (!value || typeof value !== "object") throw new Error("not an object");
			return value as Record<string, unknown>;
		} catch {
			throw new AssistantRuntimeError("assistant_manager_invalid", "manager response is invalid");
		}
	}

	async ensureSession(input: {
		externalId: string;
		principal: Principal;
		toolToken: string;
	}): Promise<string> {
		const wire = await this.#post("/v1/sessions/ensure", {
			schema_version: 1,
			external_session_id: input.externalId,
			profile: "lab-console-dashboard",
			principal: { id: input.principal.id, kind: input.principal.kind },
			mcp: {
				url: `${this.#publicConsoleUrl}/api/v1/assistant/mcp`,
				bearer_token: input.toolToken,
			},
		});
		if (!wire || typeof wire["session_id"] !== "string" || wire["session_id"].length > 256)
			throw new AssistantRuntimeError("assistant_manager_invalid", "manager omitted session id");
		return wire["session_id"];
	}

	async sendMessage(
		sessionId: string,
		input: { messageId: string; kind: "user" | "context"; content: string },
	): Promise<{ messageId: string; content: string; toolResults: unknown[] }> {
		const wire = await this.#post(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
			schema_version: 1,
			message_id: input.messageId,
			kind: input.kind,
			content: input.content,
		});
		return this.#message(wire);
	}

	async lookupMessage(
		sessionId: string,
		messageId: string,
	): Promise<{ messageId: string; content: string; toolResults: unknown[] } | null> {
		const wire = await this.#post(
			`/v1/sessions/${encodeURIComponent(sessionId)}/messages/lookup`,
			{ schema_version: 1, message_id: messageId },
			true,
		);
		return wire ? this.#message(wire) : null;
	}

	#message(wire: Record<string, unknown> | null): {
		messageId: string;
		content: string;
		toolResults: unknown[];
	} {
		if (
			!wire ||
			typeof wire["message_id"] !== "string" ||
			typeof wire["content"] !== "string" ||
			wire["content"].length > 100_000
		)
			throw new AssistantRuntimeError(
				"assistant_manager_invalid",
				"manager returned invalid message",
			);
		const result = {
			messageId: wire["message_id"],
			content: wire["content"],
			toolResults: Array.isArray(wire["tool_results"]) ? wire["tool_results"] : [],
		};
		if (!scrubUnknown(result, "assistant.response").ok)
			throw new AssistantRuntimeError(
				"assistant_manager_invalid",
				"manager returned secret content",
			);
		return result;
	}
}

export class AssistantRuntime {
	readonly writer: Sql;
	readonly manager: ClaudeCodeAssistantManager;
	constructor(writer: Sql, manager: ClaudeCodeAssistantManager) {
		this.writer = writer;
		this.manager = manager;
	}

	async send(
		principal: Principal,
		input: { id: string; kind: "user" | "context"; content: string },
	): Promise<AssistantMessageResult> {
		const scrubbed = scrubUnknown(input.content, "assistant.message");
		if (!scrubbed.ok)
			throw new AssistantRuntimeError(
				"secret_detected",
				"assistant messages cannot contain secrets",
			);
		const externalId = createHash("sha256")
			.update(`lab-console-dashboard\0${principal.id}`)
			.digest("hex");
		await this.writer`
			insert into assistant_sessions (principal_id, principal_kind, tiers, lanes, external_session_id)
			values (${principal.id}, ${principal.kind}, ${this.writer.json([...principal.tiers])}, ${this.writer.json([...principal.lanes])}, ${externalId})
			on conflict (principal_id) do update set
			  principal_kind = excluded.principal_kind, tiers = excluded.tiers, lanes = excluded.lanes,
			  updated_at = now()`;
		interface MessageRow {
			request_hash: string;
			response_id: string | null;
			state: "ready" | "dispatching" | "complete";
			dispatch_started_at: string | Date | null;
			message_seq: string;
		}
		const requestHash = sha256(`${input.kind}\0${input.content}`);
		const known = await this.writer<MessageRow[]>`
			select request_hash, response_id, state, dispatch_started_at, message_seq::text
			from assistant_messages where principal_id = ${principal.id} and message_id = ${input.id}`;
		if (known[0] && known[0].request_hash !== requestHash)
			throw new AssistantRuntimeError("id_reused", "message id was reused with different content");
		if (known[0]?.state === "dispatching") {
			const started = known[0].dispatch_started_at
				? new Date(known[0].dispatch_started_at).getTime()
				: Date.now();
			if (Date.now() - started < STALE_MESSAGE_MS)
				throw new AssistantRuntimeError(
					"message_in_flight",
					"assistant message is in flight",
					true,
				);
		}
		const toolToken = randomBytes(32).toString("base64url");
		await this.writer`delete from assistant_tool_tokens where expires_at <= now()`;
		await this.writer`delete from assistant_tool_tokens where principal_id = ${principal.id}`;
		await this.writer`
			insert into assistant_tool_tokens (token_sha256, principal_id, expires_at)
			values (${sha256(toolToken)}, ${principal.id}, now() + interval '15 minutes')`;
		let sessionId: string;
		try {
			sessionId = await this.manager.ensureSession({ externalId, principal, toolToken });
		} catch (error) {
			await this
				.writer`delete from assistant_tool_tokens where token_sha256 = ${sha256(toolToken)}`;
			throw error;
		}
		await this.writer`
			update assistant_sessions set manager_session_id = ${sessionId}, state = 'ready',
			  updated_at = now() where principal_id = ${principal.id}`;
		const finish = async (
			response: { messageId: string; content: string; toolResults: unknown[] },
			messageSeq: string,
		): Promise<AssistantMessageResult> => {
			await this.writer`
				update assistant_messages set response_id = ${response.messageId}, state = 'complete',
				  completed_at = now()
				where principal_id = ${principal.id} and message_id = ${input.id}`;
			if (input.kind === "context")
				await this.writer`
					update assistant_sessions set last_context = ${this.writer.json(JSON.parse(input.content) as never)},
					  last_context_seq = ${messageSeq}::bigint, updated_at = now()
					where principal_id = ${principal.id} and last_context_seq < ${messageSeq}::bigint`;
			return {
				schema_version: 1,
				session_id: sessionId,
				message_id: response.messageId,
				content: response.content,
				tool_results: response.toolResults,
			};
		};
		if (known[0]?.state === "complete" || known[0]?.state === "dispatching") {
			const receipt = await this.manager.lookupMessage(sessionId, input.id);
			if (receipt) return finish(receipt, known[0].message_seq);
			if (known[0].state === "complete")
				throw new AssistantRuntimeError(
					"assistant_receipt_unavailable",
					"manager lost a completed message receipt",
					true,
				);
		}
		await this.writer`
			insert into assistant_messages (principal_id, message_id, kind, request_hash)
			values (${principal.id}, ${input.id}, ${input.kind}, ${requestHash})
			on conflict (principal_id, message_id) do nothing`;
		const claimed = await this.writer<{ claimed: boolean }[]>`
			update assistant_messages set state = 'dispatching', dispatch_started_at = now()
			where principal_id = ${principal.id} and message_id = ${input.id}
			  and (state = 'ready' or (state = 'dispatching' and dispatch_started_at < now() - interval '60 seconds'))
			returning true as claimed`;
		if (!claimed[0])
			throw new AssistantRuntimeError("message_in_flight", "assistant message is in flight", true);
		const rows = await this.writer<{ message_seq: string }[]>`
			select message_seq::text from assistant_messages
			where principal_id = ${principal.id} and message_id = ${input.id}`;
		const messageSeq = rows[0]?.message_seq;
		if (!messageSeq) throw new Error("assistant message ledger row is missing");
		try {
			return finish(
				await this.manager.sendMessage(sessionId, {
					messageId: input.id,
					kind: input.kind,
					content: input.content,
				}),
				messageSeq,
			);
		} catch (error) {
			try {
				const receipt = await this.manager.lookupMessage(sessionId, input.id);
				if (receipt) return finish(receipt, messageSeq);
			} catch {
				// Preserve the original manager failure; the durable dispatch row will reconcile on retry.
			}
			throw error;
		}
	}
}
