import { command, getRequestEvent, query } from "$app/server";
import { env } from "$env/dynamic/public";
import type { OpResult, ReadEnvelope, SignalSourceModeItem } from "$lib/api/types";
import { error } from "@sveltejs/kit";
import { z } from "zod";

let mockModes: SignalSourceModeItem[] = [
	{
		source_service: "box-agent",
		mode: "development",
		note: "test-container work",
		updated_at: new Date(Date.now() - 18 * 60_000).toISOString(),
		updated_by: "janet",
	},
];

interface SignalSourceModeMutation {
	readonly item: SignalSourceModeItem;
	readonly undo?: NonNullable<OpResult["undo"]>;
}

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE !== "live";
}

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}

function forwardedHeaders(contentType = false): Headers {
	const incoming = getRequestEvent().request.headers;
	const headers = new Headers({ accept: "application/json" });
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) headers.set(name, value);
	}
	if (contentType) headers.set("content-type", "application/json");
	return headers;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await getRequestEvent().fetch(`${apiBase()}${path}`, {
		...init,
		headers: init?.headers ?? forwardedHeaders(init?.body !== undefined),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as
			| { error?: { message?: string } }
			| OpResult
			| null;
		error(
			response.status,
			body?.error?.message ?? `Console API returned ${String(response.status)}`,
		);
	}
	return (await response.json()) as T;
}

export const getSignalSourceModes = query(async (): Promise<SignalSourceModeItem[]> => {
	if (isMock()) return mockModes;
	const response = await apiJson<ReadEnvelope<SignalSourceModeItem>>("/signal-sources?limit=1000");
	return response.items;
});

const modeArgs = z
	.object({
		sourceService: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
		mode: z.enum(["normal", "development"]),
		note: z.string().max(240).optional(),
	})
	.strict();

export const setSignalSourceMode = command(
	modeArgs,
	async ({ sourceService, mode, note }): Promise<SignalSourceModeMutation> => {
		if (isMock()) {
			const previousMode =
				mockModes.find((item) => item.source_service === sourceService)?.mode ?? "normal";
			const saved: SignalSourceModeItem = {
				source_service: sourceService,
				mode,
				note: note?.trim() || null,
				updated_at: new Date().toISOString(),
				updated_by: "parker",
			};
			mockModes = [...mockModes.filter((item) => item.source_service !== sourceService), saved];
			void getSignalSourceModes().refresh();
			return {
				item: saved,
				undo: {
					op: "signal.source_mode",
					args: { source_service: sourceService, mode: previousMode },
				},
			};
		}
		const result = await apiJson<OpResult>("/op", {
			method: "POST",
			headers: forwardedHeaders(true),
			body: JSON.stringify({
				schema_version: 1,
				id: crypto.randomUUID(),
				op: "signal.source_mode",
				args: {
					source_service: sourceService,
					mode,
					...(note?.trim() ? { note: note.trim() } : {}),
				},
				dry_run: false,
			}),
		});
		if (!result.ok) error(400, result.error?.message ?? "Signal source mode could not be changed");
		void getSignalSourceModes().refresh();
		return {
			item: result.result as SignalSourceModeItem,
			...(result.undo ? { undo: result.undo } : {}),
		};
	},
);
