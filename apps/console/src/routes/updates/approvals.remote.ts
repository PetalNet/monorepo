import { getRequestEvent } from "$app/server";
const env = import.meta.env;
import { validateOpArgs } from "$lib/api/ops";
import type { OpResult, ReadEnvelope, UpdateApproval } from "$lib/api/types";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { error } from "@sveltejs/kit";
import { Effect, Schema } from "effect";
import { Command, Query } from "svelte-effect-runtime";

export type { UpdateApproval } from "$lib/api/types";

interface UpdateApprovalMutation {
	readonly approval_id: string;
	readonly box_id: string;
	readonly packages: string[];
	readonly approved_by: string;
	readonly approved_at: string;
	readonly revocable: boolean;
}

const boxIdField = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boxInput = Schema.Struct({ box_id: boxIdField }).annotate(rejectUnknownKeys);
const approveInput = Schema.Struct({
	box_id: boxIdField,
	packages: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(500),
	),
}).annotate(rejectUnknownKeys);
const revokeInput = Schema.Struct({
	approval_id: Schema.String.check(Schema.isUUID()),
	box_id: boxIdField,
}).annotate(rejectUnknownKeys);
export interface ApprovedUpdate {
	readonly approval: UpdateApprovalMutation;
	readonly undo: { op: "updates.revoke"; args: { approval_id: string } };
}

const mockApprovals = new Map<string, UpdateApproval>();

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE === "mock";
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
	const event = getRequestEvent();
	const base = env.PUBLIC_CONSOLE_API_BASE ?? `${event.url.origin}/api/v1`;
	const response = await event.fetch(`${base}${path}`, {
		...init,
		headers: init?.headers ?? forwardedHeaders(init?.body !== undefined),
	});
	const body = (await response.json().catch(() => null)) as
		| { error?: { message?: string } }
		| OpResult
		| null;
	if (!response.ok)
		error(
			response.status,
			body?.error?.message ?? `Console API returned ${String(response.status)}`,
		);
	return body as T;
}

async function runApprovalOp(
	op: "updates.approve" | "updates.revoke",
	args: Record<string, unknown>,
): Promise<OpResult> {
	const result = await apiJson<OpResult>("/op", {
		method: "POST",
		headers: forwardedHeaders(true),
		body: JSON.stringify({
			schema_version: 1,
			id: crypto.randomUUID(),
			op,
			args,
			dry_run: false,
		}),
	});
	if (!result.ok) error(400, result.error.message);
	return result;
}

export const getUpdateApprovals = Query(boxInput, ({ box_id }) =>
	Effect.promise(async () => {
		if (isMock()) return [...mockApprovals.values()].filter((item) => item.box_id === box_id);
		const result = await apiJson<ReadEnvelope<UpdateApproval>>(
			`/update-approvals?box_id=${encodeURIComponent(box_id)}`,
		);
		return result.items;
	}),
);

export const approveUpdate = Command(approveInput, ({ box_id, packages }) =>
	Effect.promise(async () => {
		const validation = validateOpArgs("updates.approve", { box_id, packages });
		if (!validation.valid) error(400, validation.errors.join("; "));
		if (isMock()) {
			const approval: UpdateApproval = {
				approval_id: crypto.randomUUID(),
				box_id,
				packages: [...new Set(packages)],
				approved_by: "you",
				approved_at: new Date().toISOString(),
				revocable: true,
				observed_at: new Date().toISOString(),
			};
			mockApprovals.set(approval.approval_id, approval);
			void Effect.runPromise(getUpdateApprovals({ box_id }).refresh());
			return {
				approval,
				undo: { op: "updates.revoke" as const, args: { approval_id: approval.approval_id } },
			};
		}
		const result = await runApprovalOp("updates.approve", {
			box_id,
			...(packages.length ? { packages } : {}),
		});
		void Effect.runPromise(getUpdateApprovals({ box_id }).refresh());
		return {
			approval: result.result as unknown as UpdateApprovalMutation,
			undo: result.undo as ApprovedUpdate["undo"],
		};
	}),
);

export const revokeUpdateApproval = Command(revokeInput, ({ approval_id, box_id }) =>
	Effect.promise(async () => {
		const validation = validateOpArgs("updates.revoke", { approval_id });
		if (!validation.valid) error(400, validation.errors.join("; "));
		if (isMock()) {
			const approval = mockApprovals.get(approval_id);
			if (!approval || approval.box_id !== box_id) error(409, "This approval is no longer pending");
			mockApprovals.delete(approval_id);
			void Effect.runPromise(getUpdateApprovals({ box_id }).refresh());
			return { approval_id, box_id, revoked_at: new Date().toISOString() };
		}
		const result = await runApprovalOp("updates.revoke", { approval_id });
		void Effect.runPromise(getUpdateApprovals({ box_id }).refresh());
		return result.result as { approval_id: string; box_id: string; revoked_at: string };
	}),
);
