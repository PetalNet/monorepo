import { getRequestEvent, query } from "$app/server";
const env = import.meta.env;
import { validateContract, type CommsEvent, type ReadEnvelope } from "$lib/api/types";
import { error } from "@sveltejs/kit";
import { z } from "zod";

const filters = z
	.object({
		type: z.enum(["task-card", "rpc", "mail"]).nullable(),
		agent: z.string().max(64).nullable(),
		taskId: z.number().int().positive().nullable(),
		cursor: z
			.string()
			.regex(/^[A-Za-z0-9_-]+$/)
			.nullable(),
	})
	.strict();

const relativeIso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}

function headers(): Headers {
	const incoming = getRequestEvent().request.headers;
	const result = new Headers({ accept: "application/json", origin: getRequestEvent().url.origin });
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) result.set(name, value);
	}
	return result;
}

function mockRows(): CommsEvent[] {
	return [
		{
			id: "105734c2-763e-4e51-8571-35d8492b0274",
			method: "comms.card",
			sender: "janet",
			recipient: "carson-2",
			task_id: 718,
			ts: relativeIso(120),
			card_id: "card-718-review",
			about: "task.dispatch",
			body_preview: "Please verify the Library backfill against the acceptance criteria.",
		},
		{
			id: "38585d47-772b-4215-a90f-408ef1428afd",
			method: "comms.rpc",
			sender: "carson-2",
			recipient: "janet",
			task_id: 718,
			in_reply_to: "105734c2-763e-4e51-8571-35d8492b0274",
			ts: relativeIso(126),
			about: "task.dispatch.response",
			body_preview: "Accepted. Running the verification suite now.",
		},
		{
			id: "b675823d-0ea4-4fa9-b673-f8978e1298fc",
			method: "comms.rpc",
			sender: "dispatcher",
			recipient: "point-fable",
			ts: relativeIso(360),
			about: "inbox.digest",
			body_preview: "4 addressed cards are waiting.",
		},
		{
			id: "fb39e6dd-6ad2-4f13-acf3-4c2e2d073ed8",
			method: "comms.mail",
			sender: "parker",
			recipient: "janet",
			ts: relativeIso(610),
			about: "control_room",
			body_preview: "!status agents-comms-log",
		},
		{
			id: "1a472f50-f4db-434e-a0f5-234c3cc1c1ca",
			method: "comms.rpc",
			sender: "control-plane",
			recipient: "hopper-3",
			task_id: 731,
			ts: relativeIso(1_260),
			about: "discipline.nag",
			body_preview: "Working without an active lease for 14 minutes.",
		},
	];
}

/** Server-side RPC: browser code never reaches the query plane directly. */
export const getCommsLog = query(
	filters,
	async ({ type, agent, taskId, cursor }): Promise<ReadEnvelope<CommsEvent>> => {
		if (env.PUBLIC_CONSOLE_DATA_MODE !== "live") {
			const needle = agent?.trim().toLocaleLowerCase();
			const method = type
				? ({ "task-card": "comms.card", rpc: "comms.rpc", mail: "comms.mail" } as const)[type]
				: null;
			const items = mockRows().filter(
				(item) =>
					(!method || item.method === method) &&
					(!needle ||
						item.sender.toLocaleLowerCase() === needle ||
						item.recipient.toLocaleLowerCase() === needle) &&
					(!taskId || item.task_id === taskId),
			);
			return {
				schema_version: 1,
				freshness: { source: "mock", observed_at: items[0]?.ts ?? new Date().toISOString() },
				items,
				next_cursor: null,
				truncated: false,
			};
		}
		const params = new URLSearchParams({ limit: "100" });
		if (type) params.set("type", type);
		if (agent?.trim()) params.set("agent", agent.trim());
		if (taskId) params.set("task_id", String(taskId));
		if (cursor) params.set("cursor", cursor);
		const response = await getRequestEvent().fetch(`${apiBase()}/comms?${params.toString()}`, {
			headers: headers(),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			error(response.status, body?.error?.message ?? "Correspondence query failed");
		}
		const result = (await response.json()) as ReadEnvelope<CommsEvent>;
		if (!result.items.every((item) => validateContract("CommsEvent", item).valid))
			error(502, "Correspondence response failed its contract");
		return result;
	},
);
