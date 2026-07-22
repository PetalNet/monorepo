import type { CommsEvent, ReadEnvelope } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { currentPrincipal } from "$lib/server/domain/principal";
import { readCommsLog } from "$lib/server/domain/reads/comms";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect, Schema } from "effect";
import { Error as HttpError, Query } from "svelte-effect-runtime";

const filters = Schema.Struct({
	type: Schema.NullOr(Schema.Literals(["task-card", "rpc", "mail"])),
	agent: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
	taskId: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
	cursor: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
}).annotate(rejectUnknownKeys);

const relativeIso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();

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
export const getCommsLog = Query(filters, ({ type, agent, taskId, cursor }) =>
	Effect.gen(function* () {
		if (publicConfig.dataMode === "mock") {
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
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return (yield* Effect.promise(() =>
			readCommsLog(services.db.app, principal.scopes, {
				...(type ? { type } : {}),
				...(agent?.trim() ? { agent: agent.trim() } : {}),
				...(taskId ? { taskId } : {}),
				...(cursor ? { cursor } : {}),
				limit: 100,
			}),
		).pipe(
			Effect.catch(() => HttpError("InternalServerError", "Correspondence query failed")),
		)) as ReadEnvelope<CommsEvent>;
	}),
);
