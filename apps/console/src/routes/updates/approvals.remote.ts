import { getRequestEvent, command, query } from "$app/server";
import { env } from "$env/dynamic/public";
import type { OpResult, ReadEnvelope, UpdateApproval } from "$lib/api/types";
import { error } from "@sveltejs/kit";
import { z } from "zod";

export type { UpdateApproval } from "$lib/api/types";

interface UpdateApprovalMutation {
	readonly approval_id: string;
	readonly box_id: string;
	readonly packages: string[];
	readonly approved_by: string;
	readonly approved_at: string;
	readonly revocable: boolean;
}

const boxInput = z.object({ box_id: z.string().min(1).max(256) }).strict();
const approveInput = boxInput
	.extend({ packages: z.array(z.string().min(1).max(256)).min(1).max(500) })
	.strict();
const revokeInput = z
	.object({ approval_id: z.string().uuid(), box_id: z.string().min(1).max(256) })
	.strict();

export interface ApprovedUpdate {
	readonly approval: UpdateApprovalMutation;
	readonly undo: { op: "updates.revoke"; args: { approval_id: string } };
}

const mockApprovals = new Map<string, UpdateApproval>();

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE !== "live";
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
	const base = env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
	const response = await getRequestEvent().fetch(`${base}${path}`, {
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
	if (!result.ok) error(400, result.error?.message ?? "Approval operation failed");
	return result;
}

export const getUpdateApprovals = query(boxInput, async ({ box_id }) => {
	if (isMock()) return [...mockApprovals.values()].filter((item) => item.box_id === box_id);
	const result = await apiJson<ReadEnvelope<UpdateApproval>>(
		`/update-approvals?box_id=${encodeURIComponent(box_id)}`,
	);
	return result.items;
});

export const approveUpdate = command(approveInput, async ({ box_id, packages }) => {
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
		void getUpdateApprovals({ box_id }).refresh();
		return {
			approval,
			undo: { op: "updates.revoke" as const, args: { approval_id: approval.approval_id } },
		};
	}
	const result = await runApprovalOp("updates.approve", {
		box_id,
		...(packages.length ? { packages } : {}),
	});
	void getUpdateApprovals({ box_id }).refresh();
	return {
		approval: result.result as unknown as UpdateApprovalMutation,
		undo: result.undo as ApprovedUpdate["undo"],
	};
});

export const revokeUpdateApproval = command(revokeInput, async ({ approval_id, box_id }) => {
	if (isMock()) {
		const approval = mockApprovals.get(approval_id);
		if (!approval || approval.box_id !== box_id) error(409, "This approval is no longer pending");
		mockApprovals.delete(approval_id);
		void getUpdateApprovals({ box_id }).refresh();
		return { approval_id, box_id, revoked_at: new Date().toISOString() };
	}
	const result = await runApprovalOp("updates.revoke", { approval_id });
	void getUpdateApprovals({ box_id }).refresh();
	return result.result as { approval_id: string; box_id: string; revoked_at: string };
});
