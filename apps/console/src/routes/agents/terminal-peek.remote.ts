import { command, getRequestEvent, query } from "$app/server";
import { env } from "$env/dynamic/public";
import { mockPtyLines } from "$lib/data/terminal";
import { error } from "@sveltejs/kit";
import { z } from "zod";

const targetSchema = z
	.object({
		host: z.string().min(1).max(253),
		tmux_session: z.string().min(1).max(128),
		pane_id: z.string().regex(/^%[0-9]+$/),
	})
	.strict();
const pollSchema = z
	.object({
		stream_id: z
			.string()
			.uuid()
			.or(z.string().regex(/^mock-/)),
		tick: z.number().int().nonnegative(),
	})
	.strict();
const detachSchema = z.object({ stream_id: pollSchema.shape.stream_id }).strict();

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
export const openTerminalPeek = command(targetSchema, async (target): Promise<PtySnapshot> => {
	if (env.PUBLIC_CONSOLE_DATA_MODE !== "live") return mockSnapshot();
	return apiJson<PtySnapshot>("/terminal/peek", {
		method: "POST",
		headers: headers(true),
		body: JSON.stringify({ ...target, scrollback_lines: 10_000 }),
	});
});

/** Polls an already-authorized server session; tick prevents Remote Function result reuse. */
export const pollTerminalPeek = query(
	pollSchema,
	async ({ stream_id, tick }): Promise<PtySnapshot> => {
		if (env.PUBLIC_CONSOLE_DATA_MODE !== "live") return mockSnapshot(stream_id, tick + 1);
		return apiJson<PtySnapshot>(`/terminal/peek/${encodeURIComponent(stream_id)}`, {
			headers: headers(),
			cache: "no-store",
		});
	},
);

export const closeTerminalPeek = command(detachSchema, async ({ stream_id }): Promise<void> => {
	if (env.PUBLIC_CONSOLE_DATA_MODE !== "live") return;
	await apiJson(`/terminal/streams/${encodeURIComponent(stream_id)}/detach`, {
		method: "POST",
		headers: headers(true),
		body: "{}",
	});
});
