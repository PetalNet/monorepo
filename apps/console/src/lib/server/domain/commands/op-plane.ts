// The authoritative named-op command plane (contract §1.1), owned by the domain layer. This is the
// in-process command path — decode, catalog lookup, arg validation, confirmation, authorization,
// proposal posture, executor evidence, dry-run, dispatch, and intent/outcome auditing — that BOTH
// the HTTP surface (api/console-api.ts) and the in-process remote (operations.remote.ts) call. It
// lives here, in the domain, so neither caller imports the command plane FROM the HTTP file: the
// dependency arrow points from the edges into the domain, never back out.
import { createHash, randomUUID } from "node:crypto";

import { Effect, Exit, Schema } from "effect";

import { asynchronously } from "#domain/iteration";
import { formatUnknown } from "#format";

import {
	canonicalJson,
	CONTRACTS_DIR,
	readSchema,
	validateJsonSchema,
	type JsonSchema,
} from "../../api/json-schema.ts";
import { OpCallSchema } from "../api-schema.ts";
import { AssistantRuntimeError } from "../assistant/runtime.ts";
import type { Principal } from "../auth/principal.ts";
import { ProposalError, proposeMutation } from "../auth/proposals.ts";
import { type GrantRelation, shouldProposeMutation } from "../auth/tiers.ts";
import { uuidv5 } from "../bridge/uuid5.ts";
import {
	DashboardError,
	saveDashboard,
	setHomeDashboard,
	updateLibraryItemStatus,
} from "../dashboard/store.ts";
import { KeyCeremonyError } from "../network/key-ceremony.ts";
import { MatrixDeliveryError } from "../notifications/matrix.ts";
import { sanitizedException, type ExceptionMonitor } from "../observability.ts";
import { runStructured, QueryError, type QueryRequest } from "../query/structured.ts";
import {
	CapabilityContributionError,
	proposeCapability,
	reviewCapability,
} from "../registry/contribution.ts";
import { dashboardSaveSchema } from "../render/validation.ts";
import type { Services } from "../substrate.ts";
import { TrackerCommandError } from "./tracker.ts";

type OpAuthz = {
	rule: "own" | "grant" | "own_or_grant" | "read" | "scope_visible" | "self";
	relation?: GrantRelation;
	scope_any?: string[];
};
type OpEntry = {
	op: string;
	lane: string;
	human_only?: boolean;
	authz: OpAuthz;
	executor: string;
	args: JsonSchema;
	emits: string[];
	requires_reason?: boolean;
	confirm?: "soft" | "typed-name";
	undo?: boolean;
	testable: "disposable" | "dry-run-only" | "live-canary";
};

function resolvedOpCapabilities(
	op: string,
	principalKind: Principal["kind"],
	proposalRequired: boolean,
): Record<string, boolean> {
	if (op !== "task.update" && op !== "task.close") return {};
	return { force: principalKind === "human" && !proposalRequired };
}

const opCatalog = readSchema(new URL("ops.json", CONTRACTS_DIR)) as {
	schema_version: number;
	ops: OpEntry[];
};
if (opCatalog.schema_version !== 2) throw new Error("unsupported op catalog schema version");
const OP_BY_NAME = new Map(opCatalog.ops.map((entry) => [entry.op, entry]));
if (OP_BY_NAME.size !== opCatalog.ops.length) throw new Error("duplicate operation in ops.json");
const INTERNAL_OP_ADAPTERS = new Set([
	"task.claim",
	"edge.enroll.approve",
	"edge.enroll.deny",
	"edge.key.revoke",
	"stats.query",
	"viz.render",
	"text.surface",
	"window.arrange",
	"dashboard.save",
	"dashboard.set_home",
	"governance.user_tier",
	"context.receive",
	"signal.source_mode",
	"library.item.update",
	"library.capability.propose",
	"library.capability.review",
	"delivery.test",
	"delivery.set_target",
	"delivery.resend",
	"delivery.cocoon",
	"updates.approve",
	"updates.revoke",
]);

type OpCall = typeof OpCallSchema.Type & { readonly dry_run: boolean };
type OpTarget = Record<string, unknown> & { scope?: string; owner?: string | null };

function opEnvelope(
	call: Pick<OpCall, "id">,
	body: Record<string, unknown>,
): Record<string, unknown> {
	return { schema_version: 1, in_reply_to: call.id, ...body };
}

function pathValue(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export async function maybePropose(
	services: Services,
	principal: Principal,
	operation: string,
	requestId: string,
	args: unknown,
	object: string | null,
	minimumRelation: GrantRelation,
): Promise<Record<string, unknown> | null> {
	if (!(await shouldProposeMutation(services.db.admin, principal, object, minimumRelation)))
		return null;
	if (!services.trackerProposals || !services.trackerProposalLookup)
		throw new ProposalError(
			"tracker_unavailable",
			"tracker proposal writer is not configured",
			true,
		);
	return proposeMutation(
		services.db.writer,
		services.trackerProposals,
		services.trackerProposalLookup,
		principal,
		{ operation, requestId, args },
	);
}

const relationRank: Record<GrantRelation, number> = {
	viewer: 0,
	editor: 1,
	operator: 2,
	owner: 3,
};

async function loadOpTarget(
	services: Services,
	entry: OpEntry,
	args: Record<string, unknown>,
): Promise<OpTarget | null> {
	const rawId =
		args["id"] ??
		args["dashboard_id"] ??
		args["item_id"] ??
		args["proposal_id"] ??
		args["request_id"];
	if (typeof rawId === "number" && services.tracker) {
		const task = services.tracker.tasks(2_000).find((row) => Number(row["id"]) === rawId);
		if (task) {
			const project = typeof task.project_name === "string" ? task.project_name : null;
			const owner = typeof task.owner === "string" ? task.owner : null;
			return {
				...task,
				project_id: project,
				...(owner ? { owner } : {}),
				scope:
					task.visibility === "private" && owner
						? `user:${owner}`
						: project
							? `project:${project}`
							: "fleet",
			};
		}
	}
	if (typeof rawId === "string") {
		if (entry.op === "library.capability.review") {
			const proposals = await services.db.admin<
				{ id: string; scope: string; proposed_by: string | null }[]
			>`select id, scope, proposed_by from library_curation where id = ${rawId}`;
			const proposal = proposals.at(0);
			if (proposal) return { ...proposal, owner: proposal.proposed_by };
		}
		const items = await services.db.admin<
			{
				id: string;
				scope: string;
				created_by: string | null;
				responsible_human: string | null;
				payload: Record<string, unknown>;
			}[]
		>`select id, scope, created_by, responsible_human, payload from items_min where id = ${rawId}`;
		const item = items.at(0);
		if (item)
			return {
				...item.payload,
				id: item.id,
				scope: item.scope,
				...((item.created_by ?? item.responsible_human)
					? { owner: item.created_by ?? item.responsible_human }
					: {}),
				created_by: item.created_by,
			};
		const events = await services.db.admin<
			{ scope: string; dimensions: Record<string, unknown>; meta: Record<string, unknown> }[]
		>`select scope, dimensions, meta from events where subject = ${rawId} order by seq desc limit 1`;
		const event = events.at(0);
		if (event) return { ...event.meta, ...event.dimensions, scope: event.scope };
	}
	if (typeof args["pubkey_fp"] === "string") {
		const edges = await services.db.admin<
			{ subject: string; scope: string; state: Record<string, unknown> }[]
		>`select subject, scope, state from current_state
		  where kind = 'edge' and state->>'pubkey_fp' = ${args["pubkey_fp"]}
		  order by seq desc limit 1`;
		const edge = edges.at(0);
		if (edge) return { ...edge.state, subject: edge.subject, scope: edge.scope };
	}
	if (entry.op === "subscription.set" || entry.op === "subscription.remove") {
		const owner = typeof args["owner"] === "string" ? args["owner"] : null;
		return owner ? { owner, scope: `user:${owner}` } : null;
	}
	return null;
}

function resolveScopeTemplate(
	template: string,
	args: Record<string, unknown>,
	target: OpTarget | null,
): string | null {
	const state: { unresolved: boolean } = { unresolved: false };
	const resolved = template.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
		const value = expression.startsWith("target.")
			? pathValue(target, expression.slice(7))
			: expression.startsWith("item.")
				? pathValue(args["item"], expression.slice(5))
				: pathValue(args, expression);
		if (value === undefined || value === null || typeof value === "object") {
			state.unresolved = true;
			return "";
		}
		return formatUnknown(value);
	});
	return state.unresolved ? null : resolved;
}

async function hasGrant(
	services: Services,
	principal: Principal,
	object: string,
	minimum: GrantRelation,
): Promise<boolean> {
	const subjects = [principal.id, ...principal.tiers.map((tier) => `tier:${tier}`)];
	const rows = await services.db.admin<{ relation: GrantRelation }[]>`
		select relation from grants where subject = any(${services.db.admin.array(subjects)})
		  and object = ${object} and condition is null and valid_at <= now()
		  and (invalid_at is null or invalid_at > now())`;
	return rows.some((row) => relationRank[row.relation] >= relationRank[minimum]);
}

async function authorizeOp(
	services: Services,
	entry: OpEntry,
	principal: Principal,
	args: Record<string, unknown>,
): Promise<
	{ ok: true; object: string | null; target: OpTarget | null } | { ok: false; message: string }
> {
	const target = await loadOpTarget(services, entry, args);
	const rule = entry.authz.rule;
	if (rule === "read") return { ok: true, object: null, target };
	if (rule === "self") {
		for (const key of ["owner", "for_user", "user", "principal_id"])
			if (typeof args[key] === "string" && args[key] !== principal.id)
				return { ok: false, message: "self operation cannot target another principal" };
		return {
			ok: true,
			object: principal.kind === "agent" ? principal.id : `user:${principal.id}`,
			target,
		};
	}
	if (rule === "scope_visible") {
		if (!target?.scope || !principal.scopes.includes(target.scope))
			return { ok: false, message: "target is not visible to the caller" };
		return { ok: true, object: target.scope, target };
	}
	const owner = target?.owner ?? target?.["created_by"] ?? target?.["responsible_human"];
	if (
		rule === "own_or_grant" &&
		(entry.op === "subscription.set" || entry.op === "subscription.remove") &&
		args["owner"] === undefined
	)
		return { ok: true, object: `user:${principal.id}`, target };
	const createsOwned = entry.op === "dashboard.save" || entry.op === "dashboard.pin";
	if (rule === "own" && (createsOwned || owner === principal.id))
		return {
			ok: true,
			object: target?.scope ?? (principal.kind === "agent" ? principal.id : `user:${principal.id}`),
			target,
		};
	if (rule === "own" || rule === "own_or_grant") {
		if (owner === principal.id) return { ok: true, object: target?.scope ?? null, target };
		if (rule === "own") return { ok: false, message: "target is not owned by the caller" };
	}
	const relation = entry.authz.relation;
	if (!relation) return { ok: false, message: "catalog grant rule is incomplete" };
	for await (const template of asynchronously(entry.authz.scope_any ?? [])) {
		const object = resolveScopeTemplate(template, args, target);
		if (object && (await hasGrant(services, principal, object, relation)))
			return { ok: true, object, target };
	}
	return { ok: false, message: `${relation} relation required on the target` };
}

async function executorEvidence(
	services: Services,
	entry: OpEntry,
	target: OpTarget | null,
	args: Record<string, unknown>,
): Promise<{
	kind: string;
	ref: string | null;
	liveness: "alive" | "suspect" | "down" | "unknown";
}> {
	if (INTERNAL_OP_ADAPTERS.has(entry.op) && entry.op.startsWith("edge.")) {
		const alive = (await services.keyCeremony?.health()) === true;
		return {
			kind: entry.executor,
			ref: "key-ceremony",
			liveness: alive ? "alive" : services.keyCeremony ? "down" : "unknown",
		};
	}
	if (entry.executor === "console-api")
		return { kind: entry.executor, ref: null, liveness: "alive" };
	if (entry.executor === "library") {
		try {
			await services.db.app`select 1 from library_items limit 1`;
			return { kind: entry.executor, ref: "library_items", liveness: "alive" };
		} catch {
			return { kind: entry.executor, ref: "library_items", liveness: "down" };
		}
	}
	if (entry.executor !== "manager") return { kind: entry.executor, ref: null, liveness: "unknown" };
	const ref = formatUnknown(args["handle"] ?? target?.["handle"] ?? "");
	if (!ref) return { kind: entry.executor, ref: null, liveness: "unknown" };
	const rows = await services.db.admin<{ observed_at: string | Date }[]>`
		select observed_at from current_state where kind = 'heartbeat' and subject = ${ref}`;

	const age = (Date.now() - new Date(rows[0].observed_at).getTime()) / 1_000;
	return {
		kind: entry.executor,
		ref,
		liveness: age <= 90 ? "alive" : age <= 300 ? "suspect" : "down",
	};
}

async function recordedOutcome(
	services: Services,
	id: string,
): Promise<Record<string, unknown> | null> {
	const outcomeId = uuidv5(`op-outcome:${id}`);
	const rows = await services.db.admin<{ meta: Record<string, unknown> }[]>`
		select meta from events where id = ${outcomeId} order by seq desc limit 1`;
	const result = rows[0].meta["op_result"];
	return result && typeof result === "object" && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: null;
}

async function auditIntent(
	services: Services,
	call: OpCall,
	principal: Principal,
	callHash: string,
): Promise<{ ok: true; seq: number; duplicate: boolean } | { ok: false; code: string }> {
	const argsHash = createHash("sha256").update(canonicalJson(call.args)).digest("hex");
	const emission = {
		schema_version: 1,
		id: call.id,
		type: "audit.op.intent",
		ts: new Date().toISOString(),
		source: { service: "console-api", host: null, agent: null },
		subject: `op:${call.id}`,
		subject_kind: "other",
		severity: "info",
		task_id: call.task_id ?? null,
		scope: "fleet",
		dimensions: {
			op: call.op,
			principal: principal.id,
			outcome: "attempted",
			dry_run: call.dry_run,
		},
		meta: {
			retention_class: "audit",
			call_hash: callHash,
			args_hash: argsHash,
			reason: call.reason ?? null,
		},
	};
	const outcome = await services.emit(
		"system:console-api",
		emission,
		Buffer.byteLength(JSON.stringify(emission)),
	);
	if (outcome.ok)
		return { ok: true, seq: outcome.seq as number, duplicate: outcome.duplicate ?? false };
	if (outcome.code === "id_reused") {
		const rows = await services.db.admin<{ seq: string; meta: Record<string, unknown> }[]>`
			select seq, meta from events where id = ${call.id} order by seq desc limit 1`;
		if (rows[0].meta["call_hash"] === callHash)
			return { ok: true, seq: Number(rows[0].seq), duplicate: true };
	}
	return { ok: false, code: outcome.code ?? "audit_unavailable" };
}

async function auditOutcome(
	services: Services,
	call: OpCall,
	principal: Principal,
	result: Record<string, unknown>,
	outcome: "ok" | "failed" | "executor_died",
): Promise<boolean> {
	const emission = {
		schema_version: 1,
		id: uuidv5(`op-outcome:${call.id}`),
		type: "audit.op.outcome",
		ts: new Date().toISOString(),
		source: { service: "console-api", host: null, agent: null },
		subject: `op:${call.id}`,
		subject_kind: "other",
		severity: outcome === "ok" ? "info" : "danger",
		task_id: call.task_id ?? null,
		scope: "fleet",
		dimensions: {
			op: call.op,
			principal: principal.id,
			outcome,
			...(call.op === "updates.apply" ? { box_id: String(call.args["box_id"]) } : {}),
		},
		meta: { retention_class: "audit", in_reply_to: call.id, op_result: result },
	};
	const emitted = await services.emit(
		"system:console-api",
		emission,
		Buffer.byteLength(JSON.stringify(emission)),
	);
	return emitted.ok;
}

async function dispatchInternalOp(
	services: Services,
	call: OpCall,
	principal: Principal,
): Promise<Record<string, unknown>> {
	switch (call.op) {
		case "edge.enroll.approve":
			if (!services.keyCeremony)
				throw new KeyCeremonyError(
					"doorman_unconfigured",
					"Doorman key ceremony is not configured",
					true,
				);
			return await services.keyCeremony.approve({
				requestId: call.id,
				pubkeyFp: String(call.args["pubkey_fp"]),
				handle: String(call.args["handle"]),
				principal: principal.id,
			});
		case "edge.enroll.deny":
			if (!services.keyCeremony)
				throw new KeyCeremonyError(
					"doorman_unconfigured",
					"Doorman key ceremony is not configured",
					true,
				);
			return await services.keyCeremony.deny({
				requestId: call.id,
				pubkeyFp: String(call.args["pubkey_fp"]),
				reason: call.reason?.trim() ?? "",
				principal: principal.id,
			});
		case "edge.key.revoke":
			if (!services.keyCeremony)
				throw new KeyCeremonyError(
					"doorman_unconfigured",
					"Doorman key ceremony is not configured",
					true,
				);
			return await services.keyCeremony.revoke({
				requestId: call.id,
				pubkeyFp: String(call.args["pubkey_fp"]),
				handle: String(call.args["confirm_name"]),
				reason: call.reason?.trim() ?? "",
				principal: principal.id,
			});
		case "library.item.update": {
			const patch = call.args["patch"] as Record<string, unknown>;
			if (
				typeof patch["status"] !== "string" ||
				!Number.isSafeInteger(patch["expected_version"]) ||
				Number(patch["expected_version"]) < 1 ||
				Object.keys(patch).some((key) => key !== "status" && key !== "expected_version")
			)
				throw new AssistantRuntimeError(
					"invalid_library_patch",
					"this adapter accepts only status and expected_version",
					false,
				);
			return await Effect.runPromise(
				updateLibraryItemStatus(
					services.db.writer,
					String(call.args["id"]),
					patch["status"],
					Number(patch["expected_version"]),
				),
			);
		}
		case "library.capability.propose":
			return proposeCapability(services.db.writer, principal, {
				capability: String(call.args["capability"]),
				title: String(call.args["title"]),
				version: String(call.args["version"]),
				scope: String(call.args["scope"]),
				reason: call.reason?.trim() ?? "",
				artifactBase64: String(call.args["artifact_base64"]),
			});
		case "library.capability.review":
			return reviewCapability(
				services.db.writer,
				String(call.args["proposal_id"]),
				call.args["decision"] as "under-review" | "promoted" | "rejected",
				principal.id,
				call.reason?.trim() ?? "",
			);
		case "task.claim":
			if (!services.trackerCommands)
				throw new TrackerCommandError(
					"tracker_unavailable",
					"tracker command writer is not configured",
					true,
				);
			return (await services.trackerCommands.claim({
				taskId: Number(call.args["id"]),
				...(typeof call.args["capability"] === "string"
					? { capability: call.args["capability"] }
					: {}),
			})) as unknown as Record<string, unknown>;
		case "stats.query":
			if (call.args["mode"] === "sql") {
				if (!principal.lanes.includes("operator") && !principal.lanes.includes("admin"))
					throw new QueryError("lane_denied", "sql mode requires operator+");
				throw new QueryError("not_implemented", "sql mode is not implemented");
			}
			return {
				...(await Effect.runPromise(
					runStructured(services.db.app, principal.scopes, call.args as unknown as QueryRequest),
				)),
			};
		case "viz.render":
			return { panel: call.args["panel"], registered: true };
		case "text.surface":
			return {
				panel: {
					schema_version: 2,
					type: "text",
					title: "Note",
					prose: call.args["prose"],
					bindings: call.args["bindings"] ?? [],
				},
			};
		case "window.arrange": {
			const rows = await services.db.writer<{ window_layout: Record<string, unknown> }[]>`
				update assistant_sessions
				set window_layout = ${services.db.writer.json({ ops: call.args["ops"] })}, updated_at = now()
				where principal_id = ${principal.id}
				returning window_layout`;
			return { schema_version: 1, layout: rows.at(0)?.window_layout ?? { ops: [] } };
		}
		case "dashboard.save": {
			const dashboard = Schema.decodeUnknownSync(dashboardSaveSchema)({
				schema_version: 1,
				id:
					typeof call.args["id"] === "string"
						? call.args["id"]
						: `dash_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
				title: call.args["title"],
				scope: call.args["scope"] ?? `user:${principal.id}`,
				panels: call.args["panels"],
				...(call.args["layout"] ? { layout: call.args["layout"] } : {}),
			});
			return await Effect.runPromise(saveDashboard(services.db, principal, dashboard));
		}
		case "dashboard.set_home":
			return await Effect.runPromise(
				setHomeDashboard(services.db.writer, principal, String(call.args["id"])),
			);
		case "governance.user_tier": {
			const userId = String(call.args["user_id"]);
			const rows = await services.db.admin<{ id: string }[]>`
				update "user"
				set tier = ${String(call.args["tier"])}, "updatedAt" = now()
				where id = ${userId}
				returning id`;
			if (!rows.at(0))
				throw new AssistantRuntimeError("user_not_found", "user was not found", false);
			return { userId, tier: call.args["tier"] };
		}
		case "context.receive":
			if (!services.assistantRuntime)
				throw new AssistantRuntimeError(
					"assistant_runtime_unavailable",
					"per-user assistant runtime is not configured",
					true,
				);
			return (await services.assistantRuntime.send(principal, {
				id: call.id,
				kind: "context",
				content: JSON.stringify(call.args["payload"]),
			})) as unknown as Record<string, unknown>;
		case "updates.approve": {
			const boxId = String(call.args["box_id"]);
			const packages = Array.isArray(call.args["packages"])
				? [...new Set(call.args["packages"].map(String))]
				: [];
			return services.db.admin.begin(async (tx) => {
				await tx`select pg_advisory_xact_lock(hashtextextended(${`updates-box:${boxId}`}, 0))`;
				const boxes = await tx<{ state: Record<string, unknown> }[]>`
					select dimensions || measures || jsonb_build_object(
					  'box_update_raw', meta->'box_update_raw'
					) as state
					from lake_events
					where type = 'box.update_status_changed' and subject = ${boxId}
					order by seq desc limit 1`;
				const box = boxes[0].state;

				if (box["apply_mode"] !== "staged-approval")
					throw new AssistantRuntimeError(
						"approval_not_staged",
						"this host is no longer in staged approval mode",
						false,
					);
				if (Number(box["pending_updates_count"] ?? 0) < 1)
					throw new AssistantRuntimeError(
						"approval_not_pending",
						"these updates are no longer pending",
						false,
					);
				const raw = box["box_update_raw"];
				const rawPackages =
					raw && typeof raw === "object" && !Array.isArray(raw)
						? (raw as Record<string, unknown>)["packages"]
						: null;
				const pendingNames = new Set(
					Array.isArray(rawPackages)
						? rawPackages.flatMap((item) =>
								item &&
								typeof item === "object" &&
								!Array.isArray(item) &&
								typeof (item as Record<string, unknown>)["name"] === "string"
									? [String((item as Record<string, unknown>)["name"])]
									: [],
							)
						: [],
				);
				if (packages.length === 0 || packages.some((name) => !pendingNames.has(name)))
					throw new AssistantRuntimeError(
						"approval_package_stale",
						"one or more packages are no longer present in collector evidence",
						false,
					);
				const active = await tx<{ packages: string[] }[]>`
					select coalesce(approved.meta->'packages', '[]'::jsonb) as packages
					from lake_events approved
					where approved.type = 'updates.approved' and approved.subject = ${boxId}
					  and not exists (
					    select 1 from lake_events later
					    where (later.type in ('updates.approval_revoked', 'updates.applied')
					      and later.dimensions->>'approval_id' = approved.dimensions->>'approval_id')
					      or (later.type = 'box.update_status_changed'
					        and later.seq > approved.seq and later.subject = approved.subject
					        and (later.dimensions->>'status' = 'up_to_date' or (
					          jsonb_typeof(later.meta->'box_update_raw'->'packages') = 'array'
					          and exists (
					            select 1 from jsonb_array_elements_text(approved.meta->'packages') as approved_package(name)
					            where not exists (
					              select 1 from jsonb_array_elements(later.meta->'box_update_raw'->'packages') pending
					              where pending->>'name' = approved_package.name
					            )
					          )
					        )))
					  )`;
				const alreadyApproved = new Set(active.flatMap((row) => row.packages));
				if (packages.some((name) => alreadyApproved.has(name)))
					throw new AssistantRuntimeError(
						"approval_already_pending",
						"one or more packages already have an active approval",
						false,
					);
				const now = new Date().toISOString();
				const approval = {
					schema_version: 1 as const,
					id: uuidv5(`updates-approved:${call.id}`),
					type: "updates.approved",
					ts: now,
					source: { service: "console-api", host: null, agent: null },
					subject: boxId,
					subject_kind: "host" as const,
					severity: "info" as const,
					scope: "fleet",
					dimensions: { approval_id: call.id, approved_by: principal.id },
					meta: { retention_class: "audit", packages },
				};
				const emitted = await services.emit(
					"system:console-api",
					approval,
					Buffer.byteLength(JSON.stringify(approval)),
				);
				if (!emitted.ok)
					throw new AssistantRuntimeError(
						emitted.code ?? "approval_failed",
						"the approval could not be recorded",
						true,
					);
				return {
					approval_id: call.id,
					box_id: boxId,
					packages,
					approved_by: principal.id,
					approved_at: now,
					revocable: true,
				};
			});
		}
		case "updates.revoke": {
			const approvalId = String(call.args["approval_id"]);
			return services.db.admin.begin(async (tx) => {
				// Serialize the check-and-revoke transition. The appender commits before this
				// transaction releases the lock, so a competing revoke observes the terminal event.
				await tx`select pg_advisory_xact_lock(hashtextextended(${`updates-approval:${approvalId}`}, 0))`;
				const active = await tx<
					{
						box_id: string;
						packages: string[];
						approved_at: string;
						approved_seq: string;
					}[]
				>`
					select approved.subject as box_id,
					       coalesce(approved.meta->'packages', '[]'::jsonb) as packages,
					       approved.ts::text as approved_at,
					       approved.seq::text as approved_seq
					from lake_events approved
					where approved.type = 'updates.approved'
					  and approved.dimensions->>'approval_id' = ${approvalId}
					  and not exists (
					    select 1 from lake_events later
					    where (
					      later.type in ('updates.approval_revoked', 'updates.applied')
					      and later.dimensions->>'approval_id' = ${approvalId}
					    ) or (
					      later.seq > approved.seq and (
					        (later.type = 'audit.op.outcome'
					          and later.dimensions->>'op' = 'updates.apply'
					          and later.dimensions->>'outcome' = 'ok'
					          and later.dimensions->>'box_id' = approved.subject)
					        or (later.type = 'box.update_status_changed'
					          and later.subject = approved.subject
					          and (later.dimensions->>'status' = 'up_to_date' or (
					            jsonb_typeof(later.meta->'box_update_raw'->'packages') = 'array'
					            and exists (
					              select 1 from jsonb_array_elements_text(approved.meta->'packages') as approved_package(name)
					              where not exists (
					                select 1 from jsonb_array_elements(later.meta->'box_update_raw'->'packages') pending
					                where pending->>'name' = approved_package.name
					              )
					            )
					          )))
					      )
					    )
					  )
					limit 1`;
				const pending = active.at(0);
				if (!pending)
					throw new AssistantRuntimeError(
						"approval_not_pending",
						"this approval was already revoked or applied",
						false,
					);

				const now = new Date().toISOString();
				const revoked = {
					schema_version: 1 as const,
					id: uuidv5(`updates-approval-revoked:${call.id}`),
					type: "updates.approval_revoked",
					ts: now,
					source: { service: "console-api", host: null, agent: null },
					subject: pending.box_id,
					subject_kind: "host" as const,
					severity: "info" as const,
					scope: "fleet",
					dimensions: { approval_id: approvalId, revoked_by: principal.id },
					meta: { retention_class: "audit", packages: pending.packages },
				};
				const emitted = await services.emit(
					"system:console-api",
					revoked,
					Buffer.byteLength(JSON.stringify(revoked)),
				);
				if (!emitted.ok)
					throw new AssistantRuntimeError(
						emitted.code ?? "approval_revoke_failed",
						"the approval could not be revoked",
						true,
					);
				const rolloutWon = await tx<{ terminal: boolean }[]>`
					select exists (
					  select 1 from lake_events later
					  where later.seq > ${pending.approved_seq}::bigint
					    and later.seq < ${emitted.seq}::bigint
					    and (
					      (later.type = 'updates.applied'
					        and later.dimensions->>'approval_id' = ${approvalId})
					      or (later.type = 'audit.op.outcome'
					        and later.dimensions->>'op' = 'updates.apply'
					        and later.dimensions->>'outcome' = 'ok'
					        and later.dimensions->>'box_id' = ${pending.box_id})
					      or (later.type = 'box.update_status_changed'
					        and later.subject = ${pending.box_id}
					        and (later.dimensions->>'status' = 'up_to_date' or (
					          jsonb_typeof(later.meta->'box_update_raw'->'packages') = 'array'
					          and exists (
					            select 1 from jsonb_array_elements_text(${tx.json(pending.packages)}::jsonb) as approved_package(name)
					            where not exists (
					              select 1 from jsonb_array_elements(later.meta->'box_update_raw'->'packages') remaining
					              where remaining->>'name' = approved_package.name
					            )
					          )
					        )))
					    )
					) as terminal`;
				if (rolloutWon[0].terminal)
					throw new AssistantRuntimeError(
						"approval_not_pending",
						"rollout began before this revocation was recorded",
						false,
					);
				return { approval_id: approvalId, box_id: pending.box_id, revoked_at: now };
			});
		}
		case "signal.snooze": {
			const pattern = String(call.args["type_pattern"]);
			const rows = await services.db.admin<
				{ subject: string; scope: string; state: Record<string, unknown> }[]
			>`select subject, scope, state from current_state
		  where kind = 'subscription' and state->>'owner' = ${principal.id}
		    and state->>'pattern' = ${pattern}
		    and coalesce((state->'storm'->>'active')::boolean, false) = true
		  limit 1`;
			const row = rows[0];

			const storm = row.state["storm"] as Record<string, unknown>;
			const now = new Date().toISOString();
			const entity = {
				...row.state,
				tier: "feed",
				updated_by: principal.id,
				updated_at: now,
				storm: { ...storm, active: false, undone_at: now, undone_by: principal.id },
			};
			const emission = {
				schema_version: 1 as const,
				id: uuidv5(`signal-storm-undo:${call.id}`),
				type: "subscription.changed",
				ts: now,
				source: { service: "console-api", host: null, agent: null },
				subject: row.subject,
				subject_kind: "other" as const,
				severity: "info" as const,
				scope: row.scope,
				dimensions: { action: "storm_undone", pattern, owner: principal.id, tier: "feed" },
				meta: { retention_class: "audit", entity },
			};
			const outcome = await services.emit(
				"system:console-api",
				emission,
				Buffer.byteLength(JSON.stringify(emission)),
			);
			if (!outcome.ok)
				throw new AssistantRuntimeError(
					outcome.code ?? "storm_undo_failed",
					"storm override could not be undone",
					true,
				);
			return { pattern, tier: "feed", restored: true, updated_at: now };
		}
		case "signal.source_mode":
			return (await services.sourceModes.set(
				principal.id,
				String(call.args["source_service"]),
				call.args["mode"] === "development" ? "development" : "normal",
				typeof call.args["note"] === "string" && call.args["note"].trim()
					? call.args["note"].trim()
					: null,
			)) as unknown as Record<string, unknown>;
		case "delivery.test":
			return (await services.delivery.test(principal.id)) as Record<string, unknown>;
		case "delivery.set_target":
			return (await services.delivery.setTarget(
				principal.id,
				String(call.args["target"]),
			)) as Record<string, unknown>;
		case "delivery.resend":
			return (await services.delivery.resend(
				principal.id,
				String(call.args["receipt_ref"]),
			)) as Record<string, unknown>;
		case "delivery.cocoon":
			return (await services.delivery.cocoon(principal.id, String(call.args["until"]))) as Record<
				string,
				unknown
			>;
		default:
			throw new AssistantRuntimeError(
				"executor_unreachable",
				`${call.op} has no configured console-api adapter`,
				true,
			);
	}
}

// --- authoritative named-op command plane --------------------------------------------------
/**
 * The full POST /api/v1/op pipeline after auth and rate limiting, usable outside HTTP: decode,
 * catalog lookup, arg validation, confirmation, authorization, proposal posture, executor evidence,
 * dry-run, dispatch, and intent/outcome auditing.
 */
async function executeOpPlaneImpl(
	services: Services,
	monitor: ExceptionMonitor,
	rawCall: unknown,
	principal: Principal,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const parsed = Schema.decodeUnknownExit(OpCallSchema)(rawCall);
	if (Exit.isFailure(parsed))
		return {
			status: 400,
			body: {
				error: {
					code: "bad_op_call",
					message: "invalid op call",
					retryable: false,
				},
			},
		};
	const call: OpCall = { ...parsed.value, dry_run: parsed.value.dry_run ?? false };
	const opError = (
		status: number,
		code: string,
		message: string,
		retryable = false,
	): { status: number; body: Record<string, unknown> } => ({
		status,
		body: opEnvelope(call, {
			ok: false,
			status: null,
			result: null,
			error: { code, message, retryable },
			audit_seq: null,
			executor: null,
			undo: null,
		}),
	});
	const entry = OP_BY_NAME.get(call.op);
	if (!entry) return opError(404, "unknown_op", "operation is not in the canonical catalog");
	const argsError = validateJsonSchema(call.args, entry.args);
	if (argsError) return opError(400, "invalid_args", argsError);
	if (entry.requires_reason && !call.reason?.trim())
		return opError(400, "reason_required", "this operation requires a reason");
	if (entry.human_only && principal.kind !== "human")
		return opError(403, "human_required", "operation is restricted to human principals");
	if (!principal.lanes.includes(entry.lane))
		return opError(403, "lane_denied", `${entry.lane} lane required`);
	const preloadedTarget =
		entry.confirm === "typed-name" ? await loadOpTarget(services, entry, call.args) : null;
	if (entry.confirm === "typed-name") {
		const expected =
			call.args["handle"] ??
			call.args["service"] ??
			call.args["box_id"] ??
			preloadedTarget?.["handle"] ??
			call.args["id"];
		if (
			typeof expected !== "string" ||
			formatUnknown(call.args["confirm_name"] ?? "")
				.trim()
				.toLowerCase() !== expected.trim().toLowerCase()
		)
			return opError(400, "confirmation_mismatch", "typed confirmation does not match the target");
	}
	const authorization = await authorizeOp(services, entry, principal, call.args);
	if (!authorization.ok) return opError(403, "scope_denied", authorization.message);
	const isRead = entry.authz.rule === "read";
	const proposalRequired =
		!isRead &&
		call.op !== "library.capability.propose" &&
		(await shouldProposeMutation(
			services.db.admin,
			principal,
			authorization.object,
			entry.authz.relation ?? "editor",
		));
	const capabilities = resolvedOpCapabilities(call.op, principal.kind, proposalRequired);
	if (call.args["force"] === true && !capabilities["force"])
		return opError(
			403,
			"force_denied",
			"force requires server-resolved commit authority on the target",
		);
	const executor = await executorEvidence(services, entry, authorization.target, call.args);
	if (executor.liveness !== "alive")
		return {
			status: 503,
			body: opEnvelope(call, {
				ok: false,
				status: null,
				result: null,
				error: {
					code: "executor_unreachable",
					message: `${entry.executor} has no positive alive evidence`,
					retryable: true,
				},
				audit_seq: null,
				executor,
				undo: null,
			}),
		};
	if (!call.dry_run && entry.testable === "dry-run-only")
		return opError(409, "dry_run_required", "this operation is enabled only for dry-run");
	if (!call.dry_run && entry.executor !== "console-api" && !INTERNAL_OP_ADAPTERS.has(call.op))
		return opError(
			503,
			"executor_unreachable",
			`${entry.executor} has no configured command adapter`,
			true,
		);
	const isStormRestore = call.op === "signal.snooze" && call.args["restore"] === true;
	if (!call.dry_run && !INTERNAL_OP_ADAPTERS.has(call.op) && !isStormRestore)
		return opError(
			503,
			"executor_unreachable",
			`${call.op} has no configured command adapter`,
			true,
		);
	const callHash = createHash("sha256").update(canonicalJson(call)).digest("hex");
	let auditSeq: number | null = null;
	if (!isRead) {
		const intent = await auditIntent(services, call, principal, callHash);
		if (!intent.ok)
			return opError(
				intent.code === "id_reused" ? 409 : 503,
				intent.code,
				intent.code === "id_reused"
					? "operation id was already used with a different body"
					: "intent audit could not be committed",
				intent.code !== "id_reused",
			);
		auditSeq = intent.seq;
		if (intent.duplicate) {
			const existing = await recordedOutcome(services, call.id);
			if (existing) return { status: 200, body: existing };
			return opError(
				409,
				"op_in_flight",
				"operation was already accepted and is awaiting reconciliation",
				true,
			);
		}
	}
	if (call.dry_run) {
		const result = opEnvelope(call, {
			ok: true,
			status: "applied",
			result: {
				dry_run: true,
				op: call.op,
				effect: proposalRequired ? "propose" : "commit",
				capabilities,
			},
			error: null,
			audit_seq: auditSeq,
			executor,
			undo: null,
		});
		if (!isRead && !(await auditOutcome(services, call, principal, result, "ok")))
			return opError(503, "audit_unavailable", "dry-run outcome audit failed", true);
		return { status: 200, body: result };
	}
	if (proposalRequired) {
		try {
			const proposed = await maybePropose(
				services,
				principal,
				call.op,
				call.id,
				call.args,
				authorization.object,
				entry.authz.relation ?? "editor",
			);
			if (!proposed)
				throw new ProposalError("proposal_unavailable", "proposal route did not activate", true);
			const result = opEnvelope(call, { ...proposed, audit_seq: auditSeq, executor, undo: null });
			if (!(await auditOutcome(services, call, principal, result, "ok")))
				return opError(
					503,
					"audit_unavailable",
					"proposal completed but outcome audit failed",
					true,
				);
			return { status: 200, body: result };
		} catch (error) {
			if (error instanceof ProposalError) {
				const failed = opEnvelope(call, {
					ok: false,
					status: null,
					result: null,
					error: { code: error.code, message: error.message, retryable: error.retryable },
					audit_seq: auditSeq,
					executor,
					undo: null,
				});
				await auditOutcome(services, call, principal, failed, "failed");
				return { status: error.code === "id_reused" ? 409 : 503, body: failed };
			}
			throw error;
		}
	}
	try {
		const operationResult = await dispatchInternalOp(services, call, principal);
		const undo =
			call.op === "updates.approve"
				? { op: "updates.revoke", args: { approval_id: call.id } }
				: call.op === "signal.source_mode"
					? {
							op: "signal.source_mode",
							args: {
								source_service: call.args["source_service"],
								mode: operationResult["previous_mode"] === "development" ? "development" : "normal",
							},
						}
					: null;
		const success = opEnvelope(call, {
			ok: true,
			status: "applied",
			result: operationResult,
			error: null,
			audit_seq: auditSeq,
			executor,
			undo,
		});
		if (!isRead && !(await auditOutcome(services, call, principal, success, "ok")))
			return opError(503, "audit_unavailable", "effect completed but outcome audit failed", true);
		return { status: 200, body: success };
	} catch (error) {
		monitor.captureException(sanitizedException(error));
		const known =
			error instanceof AssistantRuntimeError ||
			error instanceof CapabilityContributionError ||
			error instanceof DashboardError ||
			error instanceof QueryError ||
			error instanceof TrackerCommandError ||
			error instanceof MatrixDeliveryError ||
			error instanceof KeyCeremonyError;
		const code = known ? error.code : "op_failed";
		const retryable =
			error instanceof AssistantRuntimeError ||
			error instanceof TrackerCommandError ||
			error instanceof MatrixDeliveryError ||
			error instanceof KeyCeremonyError
				? error.retryable
				: false;
		const failed = opEnvelope(call, {
			ok: false,
			status: null,
			result: null,
			error: { code, message: known ? error.message : "operation failed", retryable },
			audit_seq: auditSeq,
			executor,
			undo: null,
		});
		if (!isRead) await auditOutcome(services, call, principal, failed, "failed");
		return {
			status: retryable
				? 503
				: error instanceof CapabilityContributionError && error.code === "proposal_not_found"
					? 404
					: error instanceof CapabilityContributionError
						? 409
						: 400,
			body: failed,
		};
	}
}

/**
 * The command plane exposed as a composable Effect at the domain boundary. The intricate pipeline
 * bottoms out in DB/adapter edges (the allowlisted external seam), so the faithful lift is
 * `Effect.promise` over the async implementation: the happy path and every designed failure are
 * modeled as data in the returned `{ status, body }` envelope, and an _unexpected_ fault is a
 * defect (E = never). Both the HTTP surface and the in-process remote run this Effect at their own
 * top-level edge — neither imports the command plane from the HTTP file anymore.
 */
export const executeOpPlane = (
	services: Services,
	monitor: ExceptionMonitor,
	rawCall: unknown,
	principal: Principal,
): Effect.Effect<{ status: number; body: Record<string, unknown> }> =>
	Effect.promise(() => executeOpPlaneImpl(services, monitor, rawCall, principal));
