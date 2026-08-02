import type { OpResult, ReadEnvelope, UpdateApproval } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { executeNamedOp } from "$lib/operations.remote";
import { currentPrincipal } from "$lib/server/domain/principal";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { ConsoleDomain } from "$lib/server/domain/service";
import { readUpdateApprovals } from "$lib/server/domain/updates/approvals";
import { Effect, Schema } from "effect";
import { Command, Error as HttpError, Query } from "svelte-effect-runtime";

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
	return publicConfig.dataMode === "mock";
}

function runApprovalOp(
	op: "updates.approve" | "updates.revoke",
	args: Record<string, unknown>,
): Effect.Effect<OpResult, unknown> {
	return Effect.gen(function* () {
		const result = yield* executeNamedOp({
			id: crypto.randomUUID(),
			op,
			args,
			dry_run: false,
		});
		if (!result.ok) return yield* HttpError("BadRequest", result.error.message);
		return result;
	});
}

export const getUpdateApprovals = Query(boxInput, ({ box_id }) =>
	Effect.gen(function* () {
		if (isMock()) return [...mockApprovals.values()].filter((item) => item.box_id === box_id);
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const result = (yield* readUpdateApprovals(
			services.db.app,
			principal.scopes,
			box_id,
		)) as ReadEnvelope<UpdateApproval>;
		return result.items;
	}),
);

export const approveUpdate = Command(approveInput, ({ box_id, packages }) =>
	Effect.gen(function* () {
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
			yield* getUpdateApprovals({ box_id }).refresh();
			return {
				approval,
				undo: { op: "updates.revoke" as const, args: { approval_id: approval.approval_id } },
			};
		}
		const result = yield* runApprovalOp("updates.approve", {
			box_id,
			...(packages.length ? { packages } : {}),
		});
		yield* getUpdateApprovals({ box_id }).refresh();
		return {
			// The op plane returns a loosely-typed JSON envelope (`result` is `Record | null`); narrowing
			// it to the documented mutation shape is a genuine, unavoidable narrowing of untyped JSON.
			approval: result.result as unknown as UpdateApprovalMutation,
			undo: result.undo as ApprovedUpdate["undo"],
		};
	}),
);

export const revokeUpdateApproval = Command(revokeInput, ({ approval_id, box_id }) =>
	Effect.gen(function* () {
		if (isMock()) {
			const approval = mockApprovals.get(approval_id);
			if (!approval || approval.box_id !== box_id)
				return yield* HttpError("Conflict", "This approval is no longer pending");
			mockApprovals.delete(approval_id);
			yield* getUpdateApprovals({ box_id }).refresh();
			return { approval_id, box_id, revoked_at: new Date().toISOString() };
		}
		const result = yield* runApprovalOp("updates.revoke", { approval_id });
		yield* getUpdateApprovals({ box_id }).refresh();
		return result.result as { approval_id: string; box_id: string; revoked_at: string };
	}),
);
