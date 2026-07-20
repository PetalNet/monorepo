import { command, getRequestEvent, query } from "$app/server";
const env = import.meta.env;
import { mockPtyLines } from "$lib/data/terminal";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { error } from "@sveltejs/kit";
import { Schema } from "effect";

const targetSchema = Schema.Struct({
	host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
	tmux_session: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	pane_id: Schema.String.check(Schema.isPattern(/^%[0-9]+$/)),
}).annotate(rejectUnknownKeys);
const streamIdSchema = Schema.Union([
	Schema.String.check(Schema.isUUID()),
	Schema.String.check(Schema.isPattern(/^mock-/)),
]);
const pollSchema = Schema.Struct({
	stream_id: streamIdSchema,
	tick: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).annotate(rejectUnknownKeys);
const detachSchema = Schema.Struct({ stream_id: streamIdSchema }).annotate(rejectUnknownKeys);

export interface PtySnapshot {
	readonly stream_id: string;
	readonly seq: number;
	readonly data_b64: string;
}

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}

function headers(json = false): Headers {
	const incoming = getRequestEvent().request.headers;
	const result = new Headers({ accept: "application/json", origin: getRequestEvent().url.origin });
	if (json) result.set("content-type", "application/json");
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) result.set(name, value);
	}
	return result;
}

function mockSnapshot(streamId = `mock-${crypto.randomUUID()}`, seq = 1): PtySnapshot {
	return {
		stream_id: streamId,
		seq,
		data_b64: Buffer.from(mockPtyLines.join("\n")).toString("base64"),
	};
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await getRequestEvent().fetch(`${apiBase()}${path}`, init);
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		error(response.status, body?.error?.message ?? "Terminal peek failed");
	}
	return (await response.json()) as T;
}

/** Opens the audited read-only PTY path. No attach or input operation is exposed by this module. */
export const openTerminalPeek = command(
	Schema.toStandardSchemaV1(targetSchema),
	async (target): Promise<PtySnapshot> => {
		if (env.PUBLIC_CONSOLE_DATA_MODE === "mock") return mockSnapshot();
		return apiJson<PtySnapshot>("/terminal/peek", {
			method: "POST",
			headers: headers(true),
			body: JSON.stringify({ ...target, scrollback_lines: 10_000 }),
		});
	},
);

/** Polls an already-authorized server session; tick prevents Remote Function result reuse. */
export const pollTerminalPeek = query(
	Schema.toStandardSchemaV1(pollSchema),
	async ({ stream_id, tick }): Promise<PtySnapshot> => {
		if (env.PUBLIC_CONSOLE_DATA_MODE === "mock") return mockSnapshot(stream_id, tick + 1);
		return apiJson<PtySnapshot>(`/terminal/peek/${encodeURIComponent(stream_id)}`, {
			headers: headers(),
			cache: "no-store",
		});
	},
);

export const closeTerminalPeek = command(
	Schema.toStandardSchemaV1(detachSchema),
	async ({ stream_id }): Promise<void> => {
		if (env.PUBLIC_CONSOLE_DATA_MODE === "mock") return;
		await apiJson(`/terminal/streams/${encodeURIComponent(stream_id)}/detach`, {
			method: "POST",
			headers: headers(true),
			body: "{}",
		});
	},
);
