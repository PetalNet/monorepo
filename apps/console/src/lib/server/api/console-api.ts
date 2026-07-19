// The HTTP surface (contract §1.1), folded out of the Fastify server into a framework-agnostic
// Web-standard router: a bearer/dev auth chain that resolves a server-stamped Principal, then the
// four-plane routes. Query, Command, and the current Library seam are all served here (the bus
// rides the host's WebSocket upgrade path via bus/connection.ts); unavailable executor adapters
// fail closed. Behavior is byte-compatible with the former buildServer: status codes, error
// codes, bodies, and headers are unchanged.
import { createHash } from "node:crypto";

import { Exit, Schema } from "effect";
import { z } from "zod";

import { asynchronously } from "#domain/iteration";
import { required } from "#format";
import { formatUnknown } from "#format";

import { OpCallSchema, QueryRequestSchema } from "../domain/api-schema.ts";
import { ask } from "../domain/assistant/engine.ts";
import { AssistantRuntimeError } from "../domain/assistant/runtime.ts";
import { handleAssistantMcp, resolveAssistantToolPrincipal } from "../domain/assistant/tools.ts";
import {
	canViewGrantObject,
	GrantError,
	grantMutationSchema,
	listGrants,
	mutateGrant,
} from "../domain/auth/grants.ts";
import {
	resolveBearer,
	resolveScopes,
	devPrincipal,
	type Principal,
} from "../domain/auth/principal.ts";
import { ProposalError, proposeMutation } from "../domain/auth/proposals.ts";
import type {
	BetterAuthSessionVerifier,
	BetterAuthSessionIdentity,
} from "../domain/auth/session.ts";
import { type GrantRelation, listTiers, shouldProposeMutation } from "../domain/auth/tiers.ts";
import { readAvailability } from "../domain/availability/service.ts";
import { uuidv5 } from "../domain/bridge/uuid5.ts";
import type { BusCounters } from "../domain/bus/connection.ts";
import { TrackerCommandError } from "../domain/commands/tracker.ts";
import { costComparisonRequestSchema } from "../domain/cost/compare.ts";
import { compareCostPair, CostComparisonUnavailableError } from "../domain/cost/service.ts";
import {
	DashboardError,
	dashboardTargetScope,
	listLibraryCapabilities,
	listLibraryCuration,
	listLibraryHolds,
	listLibraryItems,
	listLibraryLinks,
	listDashboards,
	loadDashboard,
	readLibraryItem,
	readLibraryItemHistory,
	searchLibraryPaletteItems,
	saveDashboard,
	setHomeDashboard,
	updateLibraryItemStatus,
} from "../domain/dashboard/store.ts";
import { withScopes } from "../domain/db/pool.ts";
import { scrubUnknown } from "../domain/ingest/scrubber.ts";
import { KeyCeremonyError } from "../domain/network/key-ceremony.ts";
import { MatrixDeliveryError } from "../domain/notifications/matrix.ts";
import {
	inertExceptionMonitor,
	reportSelfEmissionFailure,
	sanitizedException,
	type ExceptionMonitor,
} from "../domain/observability.ts";
import { rankPaletteCandidates, type PaletteCandidate } from "../domain/palette/search.ts";
import type { ProjectionKind } from "../domain/projector/index.ts";
import { branchQuery } from "../domain/query/branch.ts";
import { readQueryRecord } from "../domain/query/history.ts";
import { runStructured, QueryError, type QueryRequest } from "../domain/query/structured.ts";
import { decodeCommsCursor, readCommsLog, type CommsType } from "../domain/reads/comms.ts";
import {
	readBoxUpdateRaw,
	readDeliveryConfig,
	readEntity,
	readSignalSourceModes,
	searchEntity,
	type ReadOpts,
	readTypedEntity,
} from "../domain/reads/entities.ts";
import { readRoster, readExecutors } from "../domain/reads/roster.ts";
import { readTasks, readLeases, readAgents } from "../domain/reads/tracker-reads.ts";
import type { TrackerReader } from "../domain/reads/tracker.ts";
import { readWorkSettlement } from "../domain/reads/work-settlement.ts";
import { acquireCapability, CapabilityAcquisitionError } from "../domain/registry/acquisition.ts";
import {
	CapabilityContributionError,
	proposeCapability,
	reviewCapability,
} from "../domain/registry/contribution.ts";
import { materializePanel } from "../domain/render/engine.ts";
import type { PanelSpecV2 } from "../domain/render/types.ts";
import {
	dashboardSaveSchema,
	investigationBranchSchema,
	renderRequestSchema,
	selectedMarkSchema,
} from "../domain/render/validation.ts";
import { mergeSemanticShape, type SemanticShape } from "../domain/semantic/registry.ts";
import { searchSemanticCorpus } from "../domain/semantic/search.ts";
import type { Services } from "../domain/substrate.ts";
import {
	canonicalJson,
	CONTRACTS_DIR,
	readSchema,
	validateJsonSchema,
	type JsonSchema,
} from "./json-schema.ts";

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

export interface TerminalTarget {
	readonly host: string;
	readonly tmuxSession: string;
	readonly paneId: string;
}

export interface TerminalAdapter {
	health(): Promise<boolean>;
	capture(target: TerminalTarget, scrollbackLines: number): Promise<Buffer>;
	input(target: TerminalTarget, data: Buffer): Promise<void>;
}

/** Deferred production PTY seam. Tests inject a bounded adapter explicitly. */
class UnavailableTerminalAdapter implements TerminalAdapter {
	health(): Promise<boolean> {
		return Promise.resolve(false);
	}

	capture(_target: TerminalTarget, _scrollbackLines: number): Promise<Buffer> {
		return Promise.reject(new Error("PTY adapter is not configured"));
	}

	input(_target: TerminalTarget, _data: Buffer): Promise<void> {
		return Promise.reject(new Error("PTY adapter is not configured"));
	}
}

export function resolvedOpCapabilities(
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

const askRequestSchema = z.object({ question: z.string().min(1).max(2_000) }).strict();
const assistantMessageSchema = z
	.object({ id: z.uuid(), message: z.string().min(1).max(100_000).regex(/\S/) })
	.strict();
const assistantContextSchema = z
	.object({
		id: z.uuid(),
		payload: selectedMarkSchema.extend({
			value: z.unknown().refine((value) => value !== undefined, "value is required"),
		}),
	})
	.strict();
const LANE_ORDER = ["viewer", "editor", "operator", "admin"] as const;

async function resolveHumanIdentity(
	services: Services,
	identity: BetterAuthSessionIdentity,
): Promise<Principal | null> {
	if (identity.subject) {
		await services.db.admin`
			insert into better_auth_principals (oidc_subject, principal_id)
			values (${identity.subject}, ${identity.username}) on conflict do nothing`;
		const binding = await services.db.admin<{ principal_id: string }[]>`
			select principal_id from better_auth_principals where oidc_subject = ${identity.subject}`;
		if (binding[0].principal_id !== identity.username) return null;
	}
	// Authentik owns only administrator inheritance. The console currently models an admin as the
	// owner tier; keep that explicit so a future distinct admin tier can refine the mapping. Other
	// tiers are Better-Auth-managed and must not be inferred from similarly named Authentik groups.
	const inheritsAdmin =
		identity.groups.includes("authentik Admins") || identity.groups.includes("admin");
	if (!inheritsAdmin) return null;
	const rows = await services.db.admin<
		{ name: string; default_relations: string[] }[]
	>`select name, default_relations from tiers
	  where name = 'owner'
	  order by name`;
	if (rows.length === 0) return null;
	const tiers = rows.map((row) => row.name);
	let laneCeiling = -1;
	for (const row of rows) {
		for (const relation of row.default_relations) {
			const lane = relation === "owner" ? "admin" : relation;
			laneCeiling = Math.max(laneCeiling, LANE_ORDER.indexOf(lane as (typeof LANE_ORDER)[number]));
		}
	}
	const lanes = laneCeiling < 0 ? [] : LANE_ORDER.slice(0, laneCeiling + 1);
	// TERM_ADMIN is deliberately non-hierarchical: admin alone never implies shell access. It is
	// granted by a dedicated Authentik group/tier and therefore cannot leak through lane ordering.
	if (identity.groups.includes("term_admin") || tiers.includes("term_admin"))
		(lanes as string[]).push("term_admin");
	const { scopes, zookie } = await resolveScopes(services.db.admin, identity.username, tiers);
	return {
		kind: "human",
		id: identity.username,
		tiers,
		lanes,
		scopes,
		zookie,
		...(identity.sessionId ? { authSource: "better-auth", authSessionId: identity.sessionId } : {}),
	};
}

function parseCatalogCursor(
	cursor: string | undefined,
): { type: string; inclusive: boolean } | null {
	if (!cursor) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
			v?: unknown;
			position?: unknown;
			type?: unknown;
		};
		if (
			decoded.v !== 1 ||
			(decoded.position !== "after" && decoded.position !== "at") ||
			typeof decoded.type !== "string" ||
			!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(decoded.type)
		)
			return null;
		return { type: decoded.type, inclusive: decoded.position === "at" };
	} catch {
		return null;
	}
}

function catalogCursor(type: string, inclusive: boolean): string {
	return Buffer.from(JSON.stringify({ v: 1, position: inclusive ? "at" : "after", type })).toString(
		"base64url",
	);
}

type OpCall = typeof OpCallSchema.Type & { readonly dry_run: boolean };
type OpTarget = Record<string, unknown> & { scope?: string; owner?: string | null };

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
	return Response.json(body, { status, ...(headers ? { headers } : {}) });
}

function proposalFailure(error: ProposalError): Response {
	const status =
		error.code === "id_reused"
			? 409
			: error.code === "proposal_too_large"
				? 413
				: error.code === "secret_detected"
					? 400
					: 503;
	return jsonResponse(status, {
		error: { code: error.code, message: error.message, retryable: error.retryable },
	});
}

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

function runtimeFailure(error: AssistantRuntimeError): Response {
	const status = error.code === "id_reused" ? 409 : error.code === "secret_detected" ? 400 : 503;
	return jsonResponse(status, {
		error: { code: error.code, message: error.message, retryable: error.retryable },
	});
}

async function libraryRead(read: () => Promise<Record<string, unknown>>): Promise<Response> {
	try {
		return jsonResponse(200, await read());
	} catch (error) {
		if (error instanceof DashboardError)
			return jsonResponse(400, {
				error: { code: error.code, message: error.message, retryable: false },
			});
		throw error;
	}
}

async function maybePropose(
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
			return updateLibraryItemStatus(
				services.db.writer,
				String(call.args["id"]),
				patch["status"],
				Number(patch["expected_version"]),
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
				...(await runStructured(
					services.db.app,
					principal.scopes,
					call.args as unknown as QueryRequest,
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
export async function executeOpPlane(
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

// --- terminal session bookkeeping ------------------------------------------------------------
type TerminalSession = {
	principalId: string;
	target: TerminalTarget;
	writable: boolean;
	attached: boolean;
	closed: boolean;
	seq: number;
	timer: ReturnType<typeof setTimeout> | null;
	end: () => void;
};
const terminalTargetSchema = z
	.object({
		host: z.string().regex(/^(?:\.[0-9]{1,3}|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/),
		tmux_session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
		pane_id: z.string().regex(/^%[0-9]+$/),
		scrollback_lines: z.number().int().min(0).max(10_000).default(500),
	})
	.strict();
const terminalInputSchema = z
	.object({
		data_b64: z
			.string()
			.max(65_536)
			.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
	})
	.strict();

// --- typed entity reads (RLS-scoped projections, N1b) ----------------------------------------
interface CurrentStateRoute {
	path: string;
	kind: ProjectionKind;
	typed?: false;
	filters?: readonly ("state" | "handle" | "owner")[];
	requiredFields?: readonly string[];
}

interface TypedStateRoute extends Omit<CurrentStateRoute, "kind" | "typed"> {
	kind: "attention" | "subscription";
	typed: true;
}

interface DeliveryRoute extends Omit<CurrentStateRoute, "kind" | "typed"> {
	kind: "delivery_config";
	typed: true;
}

type EntityRoute = CurrentStateRoute | TypedStateRoute | DeliveryRoute;

const ENTITY_ROUTES: readonly EntityRoute[] = [
	{ path: "fleet", kind: "fleet" },
	{ path: "heartbeats", kind: "heartbeat" },
	{ path: "registry", kind: "registry" },
	{ path: "governance", kind: "governance" },
	{ path: "cards", kind: "card" },
	{ path: "box-updates", kind: "box_update" },
	{ path: "workers", kind: "worker" },
	{
		path: "edge/registry",
		kind: "edge",
		filters: ["state"],
		requiredFields: ["pubkey_fp", "state"],
	},
	{
		path: "edge/sessions",
		kind: "edge_session",
		filters: ["state", "handle"],
		requiredFields: [
			"session_id",
			"handle",
			"host",
			"state",
			"established_at",
			"resumes_count",
			"last_seen_at",
			"links",
		],
	},
	{
		path: "attention",
		kind: "attention",
		typed: true,
		requiredFields: [
			"schema_version",
			"id",
			"grade",
			"source",
			"subject",
			"summary",
			"ts",
			"scope",
		],
	},
	{
		path: "subscriptions",
		kind: "subscription",
		typed: true,
		filters: ["owner"],
		requiredFields: ["schema_version", "pattern", "tier", "owner"],
	},
	{
		path: "delivery",
		kind: "delivery_config",
		typed: true,
		filters: ["owner"],
		requiredFields: ["owner", "channel", "target", "verified", "updated_at", "updated_by"],
	},
];

type QueryRecord = Record<string, string | string[] | undefined>;

/** Fastify-parity query parsing: repeated keys become arrays, `?q=` yields an empty string. */
function queryOf(url: URL): QueryRecord {
	const query: Record<string, string | string[]> = {};
	for (const key of new Set(url.searchParams.keys())) {
		const values = url.searchParams.getAll(key);
		query[key] = values.length > 1 ? values : (values[0] ?? "");
	}
	return query;
}

function readOpts(query: QueryRecord, route: EntityRoute): ReadOpts | null {
	const typed = query as { limit?: string; cursor?: string };
	const raw = query as Record<string, string | undefined>;
	if (raw["since"] && Number.isNaN(Date.parse(raw["since"]))) return null;
	const filters = new Set(route.filters ?? []);
	return {
		...(typed.limit ? { limit: Number(typed.limit) } : {}),
		...(typed.cursor ? { cursor: typed.cursor } : {}),
		...(raw["since"] ? { since: raw["since"] } : {}),
		...(filters.has("state") && raw["state"] ? { state: raw["state"] } : {}),
		...(filters.has("handle") && raw["handle"] ? { handle: raw["handle"] } : {}),
		...(filters.has("owner") && raw["owner"] ? { owner: raw["owner"] } : {}),
		...(route.requiredFields ? { requiredFields: route.requiredFields } : {}),
	};
}

interface RouteContext {
	request: Request;
	url: URL;
	params: Record<string, string>;
	principal: Principal;
	route: string;
	body: unknown;
}

interface AuthedRoute {
	method: string;
	pattern: string;
	auth: true;
	rateLimit?: boolean;
	handler: (ctx: RouteContext) => Promise<Response> | Response;
}

interface OpenRoute {
	method: string;
	pattern: string;
	auth: false;
	handler: (ctx: Omit<RouteContext, "principal">) => Promise<Response> | Response;
}

type RouteDef = AuthedRoute | OpenRoute;

export interface ConsoleApiOptions {
	devAuth: boolean;
	monitor?: ExceptionMonitor;
	terminal?: TerminalAdapter;
	betterAuth?: BetterAuthSessionVerifier | null;
	devAuthHost?: string | null;
}

export interface ConsoleApi {
	/** Serve one /api/v1 request. Returns null when the path is not part of this surface. */
	fetch(request: Request): Promise<Response | null>;
	/** Fastify-parity principal chain: bearer → better-auth verifier → dev header. */
	resolvePrincipal(headers: Headers, hostname: string): Promise<Principal | null>;
	readonly busCounters: BusCounters;
	close(): void;
}

export function buildConsoleApi(services: Services, options: ConsoleApiOptions): ConsoleApi {
	const monitor = options.monitor ?? inertExceptionMonitor;
	const terminal = options.terminal ?? new UnavailableTerminalAdapter();
	const betterAuth = options.betterAuth ?? null;
	const devAuthHost = options.devAuthHost ?? null;
	const browserOrigin = betterAuth?.consoleOrigin;
	async function emitSelf(raw: Record<string, unknown>): Promise<void> {
		try {
			const outcome = await services.emit(
				"system:console-api",
				raw,
				Buffer.byteLength(JSON.stringify(raw)),
			);
			if (!outcome.ok) reportSelfEmissionFailure(monitor, null, "rejected");
		} catch (error) {
			// If the lake itself is unavailable there is nowhere honest to persist this statistic; the
			// exception channel is deliberately independent of the lake.
			reportSelfEmissionFailure(monitor, error, "failed");
		}
	}
	let requestSample = 0;
	const busCounters: BusCounters = { clients: 0, subscriptions: 0 };
	let healthCache: Record<string, unknown> | null = null;
	let healthCacheAt = 0;
	let healthEmissionAt = 0;

	async function resolvePrincipal(headers: Headers, hostname: string): Promise<Principal | null> {
		const authz = headers.get("authorization");
		if (authz?.startsWith("Bearer ")) {
			const p = await resolveBearer(services.db.admin, authz.slice(7));
			if (p) return p;
		}
		if (betterAuth) {
			const identity = await betterAuth.getIdentity(Object.fromEntries(headers.entries()));
			if (identity) {
				const principal = await resolveHumanIdentity(services, identity);
				if (principal) return principal;
			}
		}
		if (options.devAuth) {
			if (devAuthHost && hostname !== devAuthHost) return null;
			const dev = headers.get("x-dev-principal");
			if (typeof dev === "string") {
				const p = devPrincipal(dev);
				if (p) return p;
			}
		}
		return null;
	}

	const opRateBuckets = new Map<string, { tokens: number; updatedAt: number; lastSeen: number }>();
	let opRateChecks = 0;
	function opRateLimit(principal: Principal): Response | null {
		const now = Date.now();
		const capacity = 30;
		const refillPerMs = capacity / 60_000;
		const previous = opRateBuckets.get(principal.id);
		const tokens = Math.min(
			capacity,
			(previous?.tokens ?? capacity) + (now - (previous?.updatedAt ?? now)) * refillPerMs,
		);
		opRateChecks += 1;
		if (opRateChecks % 256 === 0 || opRateBuckets.size >= 10_000) {
			for (const [key, bucket] of opRateBuckets)
				if (now - bucket.lastSeen > 10 * 60_000) opRateBuckets.delete(key);
			if (opRateBuckets.size >= 10_000) {
				const oldest = [...opRateBuckets].toSorted(
					([, left], [, right]) => left.lastSeen - right.lastSeen,
				)[0]?.[0];
				if (oldest) opRateBuckets.delete(oldest);
			}
		}
		if (tokens < 1) {
			const retryAfterS = Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1_000));
			opRateBuckets.set(principal.id, { tokens, updatedAt: now, lastSeen: now });
			return jsonResponse(
				429,
				{
					error: {
						code: "rate_limited",
						message: "command request rate exceeded",
						retryable: true,
						retry_after_s: retryAfterS,
					},
				},
				{ "retry-after": String(retryAfterS) },
			);
		}
		opRateBuckets.set(principal.id, { tokens: tokens - 1, updatedAt: now, lastSeen: now });
		return null;
	}

	const terminalSessions = new Map<string, TerminalSession>();

	async function emitTerminalAudit(
		principal: Principal,
		action: "access" | "watch" | "attach" | "input" | "detach" | "denied",
		target: TerminalTarget | null,
		streamId: string | null,
		reason: string | null = null,
	): Promise<number | null> {
		const emission = {
			schema_version: 1,
			id: crypto.randomUUID(),
			type: `term.${action}`,
			ts: new Date().toISOString(),
			source: { service: "console-api", host: null, agent: null },
			subject: streamId ? `term-stream:${streamId}` : "terminal",
			subject_kind: "other",
			severity: action === "denied" ? "danger" : "info",
			scope: "fleet",
			dimensions: {
				action,
				principal: principal.id,
				...(target
					? {
							host: target.host,
							tmux_session: target.tmuxSession,
							pane_id: target.paneId,
						}
					: {}),
				...(streamId ? { stream_id: streamId } : {}),
				...(reason ? { reason } : {}),
			},
			meta: { retention_class: "audit" },
		};
		const outcome = await services.emit(
			"system:console-api",
			emission,
			Buffer.byteLength(JSON.stringify(emission)),
		);
		return outcome.ok ? (outcome.seq as number) : null;
	}

	async function authorizeTerminal(principal: Principal): Promise<string | null> {
		if (principal.kind !== "human") return "human principal required";
		if (!principal.lanes.includes("term_admin")) return "term_admin lane required";
		if (!(await hasGrant(services, principal, "fleet", "owner")))
			return "owner relation required on fleet";
		return null;
	}

	async function visibleResidentTarget(
		principal: Principal,
		target: TerminalTarget,
	): Promise<boolean> {
		const heartbeats = await readEntity(services.db.app, principal.scopes, "heartbeat", {
			limit: 1000,
		});
		return heartbeats.items.some(
			(item) =>
				item["host"] === target.host &&
				item["tmux_session"] === target.tmuxSession &&
				item["pane_id"] === target.paneId,
		);
	}

	async function ownedTerminalSession(
		principal: Principal,
		rawStreamId: string | undefined,
	): Promise<TerminalSession | Response> {
		const denial = await authorizeTerminal(principal);
		if (denial) {
			await emitTerminalAudit(principal, "denied", null, null, denial);
			return jsonResponse(403, {
				error: { code: "term_denied", message: denial, retryable: false },
			});
		}
		const streamId = rawStreamId ?? "";
		const session = terminalSessions.get(streamId);
		if (!session || session.closed || session.principalId !== principal.id) {
			await emitTerminalAudit(principal, "denied", null, streamId || null, "stream not owned");
			return jsonResponse(404, {
				error: { code: "stream_not_found", message: "terminal stream not found", retryable: false },
			});
		}
		return session;
	}

	function trackerUnavailable(): Response | null {
		if (services.tracker) return null;
		return jsonResponse(503, {
			error: {
				code: "tracker_unavailable",
				message: "TRACKER_DB_PATH not configured",
				retryable: true,
			},
		});
	}

	const routes: RouteDef[] = [];
	const route = (def: RouteDef): void => {
		routes.push(def);
	};

	// --- authoritative named-op command plane --------------------------------------------------
	route({
		method: "POST",
		pattern: "/api/v1/op",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const { status, body } = await executeOpPlane(services, monitor, ctx.body, ctx.principal);
			return jsonResponse(status, body);
		},
	});

	// --- health (unauthenticated) --------------------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/health",
		auth: true,
		handler: async () => {
			const requestedAt = Date.now();
			if (healthCache && requestedAt - healthCacheAt < 5_000)
				return jsonResponse(200, {
					...healthCache,
					ws_clients: busCounters.clients,
					ws_subscriptions: busCounters.subscriptions,
				});
			let lake: "ok" | "down" = "ok";
			let bridges: {
				source: string;
				cursor: string | null;
				cursor_updated_at: string;
				cursor_lag_s: number;
				dead_letters: number;
				last_ingest_at: string | null;
				observed_at: string | null;
				lag_s: number | null;
			}[] = [];
			let ingest: {
				source: string;
				last_ingest_at: string;
				lag_s: number;
				rate_1m: number;
			}[] = [];
			let projectors: {
				name: string;
				through_seq: number;
				lag_events: number;
				updated_at: string;
				lag_s: number;
			}[] = [];
			let managerLastSuccessAt: string | null = null;
			let matrixSyncOkEpoch: number | null = null;
			let keyCeremonyReady = false;
			try {
				const now = Date.now();
				const [bridgeRows, ingestRows, projectorRows, managerRows, matrixRows] = await Promise.all([
					services.db.admin<
						{
							source: string;
							cursor: string | null;
							cursor_updated_at: string;
							dead_letters: string;
							last_ingest_at: string | null;
						}[]
					>`
						select c.source, c.cursor, c.updated_at::text as cursor_updated_at,
						       (select count(*)::text from bridge_dead_letter d
						        where d.source = c.source) as dead_letters,
						       (select max(e.received_at)::text from events e
						        where e.meta #>> '{bridge_source,id}' = c.source) as last_ingest_at
						from bridge_cursor c
						order by c.source`,
					services.db.admin<{ source: string; last_ingest_at: string; rate_1m: string }[]>`
						select source_service as source, max(received_at)::text as last_ingest_at,
						       count(*) filter (where received_at >= now() - interval '1 minute')::text as rate_1m
						from events group by source_service order by source_service`,
					services.db.admin<
						{ name: string; through_seq: string; updated_at: string; head: string }[]
					>`
						select p.name, p.through_seq::text, p.updated_at::text,
						       coalesce((select max(seq) from emission_ids), 0)::text as head
						from projection_checkpoint p order by p.name`,
					services.db.admin<{ last_success_at: string | null }[]>`
						select max(received_at)::text as last_success_at from events
						where source_service = 'manager' and type = 'agent.heartbeat'`,
					services.db.admin<{ sync_ok_epoch: string | null }[]>`
						select max((measures ->> 'last_sync_ok_epoch')::double precision)::bigint::text
						       as sync_ok_epoch
						from events
						where type = 'agent.heartbeat'
						  and source_service = 'manager'
						  and jsonb_typeof(measures -> 'last_sync_ok_epoch') = 'number'
						  and (measures ->> 'last_sync_ok_epoch')::double precision > 0`,
				]);
				bridges = bridgeRows.map((row) => ({
					source: row.source,
					cursor: row.cursor,
					cursor_updated_at: row.cursor_updated_at,
					cursor_lag_s: Math.max(0, (now - Date.parse(row.cursor_updated_at)) / 1000),
					dead_letters: Number(row.dead_letters),
					last_ingest_at: row.last_ingest_at,
					observed_at: row.last_ingest_at,
					lag_s: row.last_ingest_at
						? Math.max(0, (now - Date.parse(row.last_ingest_at)) / 1000)
						: null,
				}));
				ingest = ingestRows.map((row) => ({
					source: row.source,
					last_ingest_at: row.last_ingest_at,
					lag_s: Math.max(0, (now - Date.parse(row.last_ingest_at)) / 1000),
					rate_1m: Number(row.rate_1m),
				}));
				projectors = projectorRows.map((row) => ({
					name: row.name,
					through_seq: Number(row.through_seq),
					lag_events: Math.max(0, Number(row.head) - Number(row.through_seq)),
					updated_at: row.updated_at,
					lag_s: Math.max(0, (now - Date.parse(row.updated_at)) / 1000),
				}));
				managerLastSuccessAt = managerRows[0].last_success_at ?? null;
				const matrixEpoch = Number(matrixRows[0].sync_ok_epoch);
				matrixSyncOkEpoch =
					Number.isSafeInteger(matrixEpoch) && matrixEpoch > 0 ? matrixEpoch : null;
				await services.delivery.reconcileMatrixSync(matrixSyncOkEpoch).catch((error: unknown) => {
					monitor.captureException(sanitizedException(error, "delivery sync health"));
				});
			} catch (error) {
				lake = "down";
				monitor.captureException(sanitizedException(error));
			}
			if (services.keyCeremony)
				keyCeremonyReady = await services.keyCeremony.health().catch((error: unknown) => {
					monitor.captureException(sanitizedException(error, "key ceremony health"));
					return false;
				});
			const health = {
				lake,
				seq_head: services.broker.head,
				bridges,
				ingest,
				projectors,
				ws_clients: busCounters.clients,
				ws_subscriptions: busCounters.subscriptions,
				manager_last_success_at: managerLastSuccessAt,
				matrix_sync_ok_epoch: matrixSyncOkEpoch,
				readiness: {
					assistant_compiler: services.assistant ? "adapter_ready" : "unconfigured",
					assistant_runtime: services.assistantRuntime ? "adapter_ready" : "unconfigured",
					executor_key_ceremony: services.keyCeremony
						? keyCeremonyReady
							? "ready"
							: "down"
						: "unconfigured",
				},
			};
			healthCache = health;
			healthCacheAt = requestedAt;
			if (requestedAt - healthEmissionAt >= 60_000) {
				healthEmissionAt = requestedAt;
				void emitSelf({
					schema_version: 1,
					id: crypto.randomUUID(),
					type: "console.bus.health",
					ts: new Date().toISOString(),
					source: { service: "console-api", host: null, agent: null },
					subject: "console-api",
					subject_kind: "service",
					severity: lake === "ok" ? "info" : "danger",
					scope: "fleet",
					dimensions: {
						lake,
						assistant_compiler: health.readiness.assistant_compiler,
						assistant_runtime: health.readiness.assistant_runtime,
						executor_key_ceremony: health.readiness.executor_key_ceremony,
					},
					measures: {
						seq_head: health.seq_head,
						ws_clients: health.ws_clients,
						ws_subscriptions: health.ws_subscriptions,
						bridge_dead_letters: bridges.reduce((sum, bridge) => sum + bridge.dead_letters, 0),
						projector_lag_events: projectors.reduce(
							(max, projector) => Math.max(max, projector.lag_events),
							0,
						),
						ingest_rate_1m: ingest.reduce((sum, source) => sum + source.rate_1m, 0),
					},
					meta: { retention_class: "telemetry" },
				});
			}
			return jsonResponse(200, health);
		},
	});

	// --- me --------------------------------------------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/me",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			return jsonResponse(200, {
				schema_version: 1,
				kind: p.kind,
				id: p.id,
				tiers: p.tiers,
				lanes: p.lanes,
				scopes: p.scopes,
				zookie: p.zookie,
			});
		},
	});

	// --- extensible permission-level catalog ---------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/tiers",
		auth: true,
		handler: async () => jsonResponse(200, await listTiers(services.db.app)),
	});

	// --- ReBAC grants ---------------------------------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/grants",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const object = (queryOf(ctx.url) as { object?: string }).object;
			if (!object)
				return jsonResponse(400, {
					error: {
						code: "bad_object",
						message: "object query parameter is required",
						retryable: false,
					},
				});
			try {
				return jsonResponse(200, await listGrants(services.db.writer, principal, object));
			} catch (error) {
				if (!(error instanceof GrantError)) throw error;
				return jsonResponse(error.code === "grant_denied" ? 403 : 400, {
					error: { code: error.code, message: error.message, retryable: false },
				});
			}
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/grants",
		auth: true,
		handler: async (ctx) => {
			const parsed = grantMutationSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_grant",
						message: parsed.error.issues[0]?.message ?? "invalid grant",
						retryable: false,
					},
				});
			try {
				const principal = ctx.principal;
				if (!(await canViewGrantObject(services.db.admin, principal, parsed.data.object)))
					throw new GrantError("grant_denied", "object is not visible to the caller");
				const proposed = await maybePropose(
					services,
					principal,
					"grant.mutate",
					parsed.data.id,
					parsed.data,
					parsed.data.object,
					"owner",
				);
				if (proposed) return jsonResponse(200, proposed);
				return jsonResponse(200, await mutateGrant(services.db, ctx.principal, parsed.data));
			} catch (error) {
				if (error instanceof ProposalError) return proposalFailure(error);
				if (!(error instanceof GrantError)) throw error;
				return jsonResponse(
					error.code === "grant_denied" ? 403 : error.code === "bad_grant" ? 400 : 409,
					{ error: { code: error.code, message: error.message, retryable: false } },
				);
			}
		},
	});

	// --- emit ------------------------------------------------------------------------------------
	route({
		method: "POST",
		pattern: "/api/v1/emit",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const bytes = Buffer.byteLength(JSON.stringify(ctx.body ?? {}));
			const outcome = await services.emit(p, ctx.body, bytes);
			if (!outcome.ok) {
				const rateLimited =
					outcome.code === "emit_rate_limited" || outcome.code === "new_type_rate_limited";
				const appendFailed = outcome.code === "append_failed";
				const status =
					outcome.code === "unregistered_producer"
						? 403
						: rateLimited
							? 429
							: appendFailed
								? 503
								: 400;
				const retryAfterS =
					outcome.retryAfterS ?? (outcome.code === "emit_rate_limited" ? 60 : 3600);
				return jsonResponse(
					status,
					{
						error: {
							code: outcome.code,
							message: outcome.message,
							retryable: rateLimited || appendFailed,
							...(rateLimited ? { retry_after_s: retryAfterS } : {}),
						},
					},
					rateLimited ? { "retry-after": String(retryAfterS) } : undefined,
				);
			}
			return jsonResponse(202, { seq: outcome.seq, duplicate: outcome.duplicate ?? false });
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/emit/batch",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const body = ctx.body;
			if (!Array.isArray(body))
				return jsonResponse(400, {
					error: { code: "invalid_batch", message: "expected array", retryable: false },
				});
			if (body.length > 500)
				return jsonResponse(400, {
					error: { code: "batch_too_large", message: "max 500", retryable: false },
				});
			const results = [];
			for await (const item of asynchronously(body)) {
				const bytes = Buffer.byteLength(JSON.stringify(item));
				const outcome = await services.emit(p, item, bytes);
				results.push(
					outcome.ok
						? { seq: outcome.seq, duplicate: outcome.duplicate ?? false }
						: {
								error: {
									code: outcome.code,
									message: outcome.message,
									retryable:
										outcome.code === "emit_rate_limited" ||
										outcome.code === "new_type_rate_limited" ||
										outcome.code === "append_failed",
									...(outcome.retryAfterS ? { retry_after_s: outcome.retryAfterS } : {}),
								},
							},
				);
			}
			return jsonResponse(202, { results });
		},
	});

	// --- query -----------------------------------------------------------------------------------
	route({
		method: "POST",
		pattern: "/api/v1/query",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const parsed = Schema.decodeUnknownExit(QueryRequestSchema)(ctx.body);
			if (Exit.isFailure(parsed))
				return jsonResponse(400, {
					error: { code: "bad_query", message: "invalid query request", retryable: false },
				});
			const body = parsed.value as QueryRequest;
			if (body.mode === "sql") {
				if (!p.lanes.includes("operator") && !p.lanes.includes("admin"))
					return jsonResponse(403, {
						error: {
							code: "lane_denied",
							message: "sql mode requires operator+",
							retryable: false,
						},
					});
				return jsonResponse(400, {
					error: { code: "not_implemented", message: "sql mode lands in N1d", retryable: false },
				});
			}
			try {
				const result = await runStructured(services.db.app, p.scopes, body);
				return jsonResponse(200, result);
			} catch (err) {
				if (err instanceof QueryError)
					return jsonResponse(400, {
						error: { code: err.code, message: err.message, retryable: false },
					});
				throw err;
			}
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/cost/compare",
		auth: true,
		handler: async (ctx) => {
			const parsed = costComparisonRequestSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_cost_comparison",
						message: parsed.error.issues[0]?.message ?? "invalid cost comparison",
						retryable: false,
					},
				});
			const principal = ctx.principal;
			try {
				return jsonResponse(
					200,
					await compareCostPair(services.db.app, principal.scopes, parsed.data, services.costMeter),
				);
			} catch (error) {
				if (error instanceof QueryError)
					return jsonResponse(400, {
						error: { code: error.code, message: error.message, retryable: false },
					});
				if (error instanceof CostComparisonUnavailableError)
					return jsonResponse(503, {
						error: { code: "cost_meter_unavailable", message: error.message, retryable: true },
					});
				throw error;
			}
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/query/:queryRef",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const { queryRef } = ctx.params as { queryRef: string };
			const record = await readQueryRecord(services.db.app, p.scopes, queryRef);
			if (!record)
				return jsonResponse(404, {
					error: { code: "query_not_found", message: "query ref not found", retryable: false },
				});
			return jsonResponse(200, { schema_version: 1, ...record });
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/query/:queryRef/rerun",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const { queryRef } = ctx.params as { queryRef: string };
			const record = await readQueryRecord(services.db.app, p.scopes, queryRef);
			if (!record)
				return jsonResponse(404, {
					error: { code: "query_not_found", message: "query ref not found", retryable: false },
				});
			try {
				return jsonResponse(200, await runStructured(services.db.app, p.scopes, record.request));
			} catch (err) {
				if (err instanceof QueryError)
					return jsonResponse(400, {
						error: { code: err.code, message: err.message, retryable: false },
					});
				throw err;
			}
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/ask",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const parsed = askRequestSchema.safeParse(ctx.body);
			if (!parsed.success || !parsed.data.question.trim())
				return jsonResponse(400, {
					error: {
						code: "bad_question",
						message: "question is required (max 2000 chars)",
						retryable: false,
					},
				});
			if (!services.assistant)
				return jsonResponse(503, {
					error: {
						code: "assistant_unavailable",
						message: "dashboard assistant compiler is not configured",
						retryable: true,
					},
				});
			return jsonResponse(
				200,
				await ask(services.db, services.assistant, p.scopes, parsed.data.question.trim()),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/assistant/session",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const rows = await services.db.writer<
				{
					manager_session_id: string | null;
					state: string;
					window_layout: unknown;
					last_context: unknown;
				}[]
			>`select manager_session_id, state, window_layout, last_context from assistant_sessions
			  where principal_id = ${p.id}`;
			const session = rows.at(0);
			return jsonResponse(200, {
				schema_version: 1,
				session: session
					? {
							session_id: session.manager_session_id,
							state: session.state,
							window_layout: session.window_layout,
							last_context: session.last_context,
						}
					: null,
			});
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/assistant/messages",
		auth: true,
		handler: async (ctx) => {
			const parsed = assistantMessageSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: { code: "bad_message", message: "invalid assistant message", retryable: false },
				});
			if (!services.assistantRuntime)
				return jsonResponse(503, {
					error: {
						code: "assistant_runtime_unavailable",
						message: "per-user assistant runtime is not configured",
						retryable: true,
					},
				});
			try {
				return jsonResponse(
					200,
					await services.assistantRuntime.send(ctx.principal, {
						id: parsed.data.id,
						kind: "user",
						content: parsed.data.message,
					}),
				);
			} catch (error) {
				if (error instanceof AssistantRuntimeError) return runtimeFailure(error);
				throw error;
			}
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/assistant/context",
		auth: true,
		handler: async (ctx) => {
			const parsed = assistantContextSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: { code: "bad_context", message: "invalid selected context", retryable: false },
				});
			if (!scrubUnknown(parsed.data.payload, "context.payload").ok)
				return jsonResponse(400, {
					error: {
						code: "secret_detected",
						message: "context contains a secret",
						retryable: false,
					},
				});
			if (!services.assistantRuntime)
				return jsonResponse(503, {
					error: {
						code: "assistant_runtime_unavailable",
						message: "per-user assistant runtime is not configured",
						retryable: true,
					},
				});
			try {
				return jsonResponse(
					200,
					await services.assistantRuntime.send(ctx.principal, {
						id: parsed.data.id,
						kind: "context",
						content: JSON.stringify(parsed.data.payload),
					}),
				);
			} catch (error) {
				if (error instanceof AssistantRuntimeError) return runtimeFailure(error);
				throw error;
			}
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/assistant/mcp",
		auth: false,
		handler: async (ctx) => {
			const match = /^Bearer\s+(\S+)$/i.exec(ctx.request.headers.get("authorization") ?? "");
			const principal = match?.[1]
				? await resolveAssistantToolPrincipal(services.db.admin, match[1], async (sessionId) => {
						const identity = await betterAuth?.getIdentityBySessionId(sessionId);
						return identity ? resolveHumanIdentity(services, identity) : null;
					})
				: null;
			if (!principal)
				return jsonResponse(401, {
					jsonrpc: "2.0",
					id: (ctx.body as { id?: unknown } | null)?.id ?? null,
					error: { code: -32_000, message: "Unauthorized" },
				});
			return jsonResponse(200, await handleAssistantMcp(services, principal, ctx.body));
		},
	});
	// Interim-surface alias: the SvelteKit catch-all served the assistant MCP plane at /mcp for any
	// authenticated principal (browser session, bearer, dev). Kept alongside the tool-token route.
	route({
		method: "POST",
		pattern: "/api/v1/mcp",
		auth: true,
		handler: async (ctx) =>
			jsonResponse(200, await handleAssistantMcp(services, ctx.principal, ctx.body)),
	});
	route({
		method: "POST",
		pattern: "/api/v1/render",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const parsed = renderRequestSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_render_request",
						message: "invalid render request",
						retryable: false,
					},
				});
			const record = await readQueryRecord(services.db.app, p.scopes, parsed.data.query_ref);
			if (!record)
				return jsonResponse(404, {
					error: { code: "query_not_found", message: "query ref not found", retryable: false },
				});
			const result = await runStructured(services.db.app, p.scopes, record.request);
			return jsonResponse(200, materializePanel(parsed.data.panel as PanelSpecV2, result));
		},
	});

	// --- renderer-agnostic saved dashboards / investigation branches ---------------------------
	route({
		method: "POST",
		pattern: "/api/v1/dashboards",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const parsed = dashboardSaveSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: { code: "bad_dashboard", message: "invalid dashboard payload", retryable: false },
				});
			try {
				const targetScope = dashboardTargetScope(p, parsed.data.scope);
				if (!targetScope || !p.scopes.includes(targetScope))
					throw new DashboardError("scope_denied", "dashboard scope is not visible to the caller");
				const proposed = await maybePropose(
					services,
					p,
					"dashboard.save",
					parsed.data.id,
					parsed.data,
					targetScope,
					"editor",
				);
				if (proposed) return jsonResponse(200, proposed);
				return jsonResponse(200, await saveDashboard(services.db, p, parsed.data));
			} catch (error) {
				if (error instanceof ProposalError) return proposalFailure(error);
				if (error instanceof DashboardError)
					return jsonResponse(error.code === "scope_denied" ? 403 : 400, {
						error: { code: error.code, message: error.message, retryable: false },
					});
				throw error;
			}
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/investigations/branches",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const parsed = investigationBranchSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_investigation_branch",
						message: "invalid investigation branch",
						retryable: false,
					},
				});
			const input = parsed.data;
			const record = await readQueryRecord(services.db.app, p.scopes, input.panel.query_ref);
			if (!record)
				return jsonResponse(404, {
					error: {
						code: "query_not_found",
						message: "parent query ref not found",
						retryable: false,
					},
				});
			try {
				const filtered = await runStructured(
					services.db.app,
					p.scopes,
					branchQuery(record.request, input.selected_mark.field, input.selected_mark.value),
				);
				const dashboard = dashboardSaveSchema.parse({
					schema_version: 1,
					id: input.id,
					title: input.title,
					...(input.scope ? { scope: input.scope } : {}),
					panels: [
						{
							schema_version: 2,
							type: input.panel.type,
							title: input.panel.title,
							description: "Investigation branch · filtered replay as the current viewer",
							query_ref: filtered.query_ref,
						},
					],
					branch: {
						parent_dashboard_id: input.parent_dashboard_id,
						parent_question: input.parent_question,
						filters: { [input.selected_mark.field]: input.selected_mark.value },
						selected_mark: { ...input.selected_mark, query_ref: filtered.query_ref },
						assumptions: [],
					},
				});
				const targetScope = dashboardTargetScope(p, dashboard.scope);
				if (!targetScope || !p.scopes.includes(targetScope))
					throw new DashboardError("scope_denied", "dashboard scope is not visible to the caller");
				const proposed = await maybePropose(
					services,
					p,
					"dashboard.save",
					input.id,
					dashboard,
					targetScope,
					"editor",
				);
				if (proposed) return jsonResponse(200, proposed);
				return jsonResponse(200, await saveDashboard(services.db, p, dashboard));
			} catch (error) {
				if (error instanceof ProposalError) return proposalFailure(error);
				if (error instanceof DashboardError || error instanceof QueryError)
					return jsonResponse(
						error instanceof DashboardError && error.code === "scope_denied" ? 403 : 400,
						{ error: { code: error.code, message: error.message, retryable: false } },
					);
				throw error;
			}
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/dashboards",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as { limit?: string; cursor?: string };
			try {
				return jsonResponse(
					200,
					await listDashboards(services.db.app, p.scopes, services.cursorSecret, {
						...(query.limit ? { limit: Number(query.limit) } : {}),
						...(query.cursor ? { cursor: query.cursor } : {}),
					}),
				);
			} catch (error) {
				if (error instanceof DashboardError)
					return jsonResponse(400, {
						error: { code: error.code, message: error.message, retryable: false },
					});
				throw error;
			}
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/dashboards/:dashboardId",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const { dashboardId } = ctx.params as { dashboardId: string };
			if (!/^dash_[A-Za-z0-9_-]{8,40}$/.test(dashboardId))
				return jsonResponse(404, {
					error: { code: "dashboard_not_found", message: "dashboard not found", retryable: false },
				});
			const dashboard = await loadDashboard(services.db.app, p.scopes, dashboardId);
			if (!dashboard)
				return jsonResponse(404, {
					error: { code: "dashboard_not_found", message: "dashboard not found", retryable: false },
				});
			return jsonResponse(200, dashboard);
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/dashboards/:dashboardId/home",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const { dashboardId } = ctx.params as { dashboardId: string };
			const parsed = z.object({ id: z.uuid() }).strict().safeParse(ctx.body);
			if (!parsed.success || !/^dash_[A-Za-z0-9_-]{8,40}$/.test(dashboardId))
				return jsonResponse(400, {
					error: {
						code: "bad_dashboard",
						message: "invalid dashboard pin request",
						retryable: false,
					},
				});
			try {
				const proposed = await maybePropose(
					services,
					p,
					"dashboard.set_home",
					parsed.data.id,
					{ id: dashboardId },
					`user:${p.id}`,
					"owner",
				);
				if (proposed) return jsonResponse(200, proposed);
				return jsonResponse(200, await setHomeDashboard(services.db.writer, p, dashboardId));
			} catch (error) {
				if (error instanceof ProposalError) return proposalFailure(error);
				if (error instanceof DashboardError)
					return jsonResponse(error.code === "scope_denied" ? 403 : 404, {
						error: { code: error.code, message: error.message, retryable: false },
					});
				throw error;
			}
		},
	});

	// --- Rev3 Library: one scope-filtered item/link store + the fleet capability registry ------
	route({
		method: "GET",
		pattern: "/api/v1/library/items",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as {
				q?: string;
				kind?: string;
				limit?: string;
				cursor?: string;
			};
			return libraryRead(() =>
				listLibraryItems(services.db.app, p.scopes, services.cursorSecret, {
					...(query.q ? { query: query.q } : {}),
					...(query.kind ? { kind: query.kind } : {}),
					...(query.limit ? { limit: Number(query.limit) } : {}),
					...(query.cursor ? { cursor: query.cursor } : {}),
				}),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/library/search",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as {
				q?: string;
				kind?: string;
				limit?: string;
				cursor?: string;
			};
			if (!query.q?.trim())
				return jsonResponse(400, {
					error: { code: "bad_library_query", message: "q is required", retryable: false },
				});
			return libraryRead(() =>
				listLibraryItems(services.db.app, p.scopes, services.cursorSecret, {
					query: required(query.q),
					...(query.kind ? { kind: query.kind } : {}),
					...(query.limit ? { limit: Number(query.limit) } : {}),
					...(query.cursor ? { cursor: query.cursor } : {}),
				}),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/library/items/:itemId",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const { itemId } = ctx.params as { itemId: string };
			if (!/^[A-Za-z0-9:_-]{1,128}$/.test(itemId))
				return jsonResponse(404, {
					error: {
						code: "library_item_not_found",
						message: "Library item not found",
						retryable: false,
					},
				});
			const item = await readLibraryItem(services.db.app, p.scopes, itemId);
			return item
				? jsonResponse(200, item)
				: jsonResponse(404, {
						error: {
							code: "library_item_not_found",
							message: "Library item not found",
							retryable: false,
						},
					});
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/library/items/:itemId/history",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			const { itemId } = ctx.params as { itemId: string };
			if (!/^[A-Za-z0-9:_-]{1,128}$/.test(itemId))
				return jsonResponse(404, {
					error: {
						code: "library_item_not_found",
						message: "Library item not found",
						retryable: false,
					},
				});
			return libraryRead(() => readLibraryItemHistory(services.db.app, p.scopes, itemId));
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/library/links",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as { item_id?: string; limit?: string; cursor?: string };
			return libraryRead(() =>
				listLibraryLinks(services.db.app, p.scopes, services.cursorSecret, query.item_id, {
					...(query.limit ? { limit: Number(query.limit) } : {}),
					...(query.cursor ? { cursor: query.cursor } : {}),
				}),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/library/holds",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as { limit?: string; cursor?: string };
			return libraryRead(() =>
				listLibraryHolds(services.db.app, p.scopes, p.id, services.cursorSecret, {
					...(query.limit ? { limit: Number(query.limit) } : {}),
					...(query.cursor ? { cursor: query.cursor } : {}),
				}),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/library/curation",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as { limit?: string; cursor?: string };
			return libraryRead(() =>
				listLibraryCuration(services.db.app, p.scopes, services.cursorSecret, {
					...(query.limit ? { limit: Number(query.limit) } : {}),
					...(query.cursor ? { cursor: query.cursor } : {}),
				}),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/library/capabilities",
		auth: true,
		handler: (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as { limit?: string; cursor?: string };
			return libraryRead(() =>
				listLibraryCapabilities(services.db.app, p.scopes, services.cursorSecret, {
					...(query.limit ? { limit: Number(query.limit) } : {}),
					...(query.cursor ? { cursor: query.cursor } : {}),
				}),
			);
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/library/capabilities/:capability/acquire",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const { capability } = ctx.params as { capability: string };
			const body = z
				.object({ provider: z.string().optional() })
				.strict()
				.safeParse(ctx.body ?? {});
			if (!body.success)
				return jsonResponse(400, {
					error: {
						code: "bad_capability",
						message: "invalid capability acquisition request",
						retryable: false,
					},
				});
			try {
				return jsonResponse(
					200,
					await acquireCapability(
						services.db.app,
						principal.scopes,
						capability,
						body.data.provider,
					),
				);
			} catch (error) {
				if (error instanceof CapabilityAcquisitionError) {
					const status =
						error.code === "bad_capability"
							? 400
							: error.code === "capability_not_found"
								? 404
								: 422;
					return jsonResponse(status, {
						error: { code: error.code, message: error.message, retryable: false },
					});
				}
				throw error;
			}
		},
	});

	// --- catalog ---------------------------------------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/catalog",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			if (p.scopes.length === 0)
				return jsonResponse(200, {
					schema_version: 1,
					freshness: {
						source: "semantic-registry",
						observed_at: new Date().toISOString(),
						window_s: null,
					},
					items: [],
					next_cursor: null,
					truncated: false,
				});
			const query = queryOf(ctx.url) as {
				type?: string;
				scope?: string;
				limit?: string;
				cursor?: string;
				since?: string;
			};
			if (query.type && !/^[a-z0-9_.*]+$/.test(query.type))
				return jsonResponse(400, {
					error: { code: "bad_catalog_filter", message: "invalid type glob", retryable: false },
				});
			if (query.since && !Number.isFinite(Date.parse(query.since)))
				return jsonResponse(400, {
					error: {
						code: "bad_catalog_filter",
						message: "invalid since timestamp",
						retryable: false,
					},
				});
			const cursor = parseCatalogCursor(query.cursor);
			if (query.cursor && !cursor)
				return jsonResponse(400, {
					error: { code: "bad_catalog_filter", message: "invalid cursor", retryable: false },
				});
			const limit = Math.min(Math.max(1, Number(query.limit ?? 200) || 200), 1000);
			const typeLike = query.type?.replaceAll("_", "#_").replaceAll("*", "%") ?? null;
			const page = await withScopes(services.db.app, p.scopes, async (tx) => {
				const types = await tx<{ type: string }[]>`
						select distinct r.type from semantic_registry_scoped r
						where (${cursor?.type ?? null}::text is null
						       or (${cursor?.inclusive ?? false} and r.type >= ${cursor?.type ?? null})
						       or (not ${cursor?.inclusive ?? false} and r.type > ${cursor?.type ?? null}))
						  and (${query.since ?? null}::timestamptz is null or r.updated_at >= ${query.since ?? null}::timestamptz)
						  and (${typeLike}::text is null or r.type like ${typeLike} escape '#')
						  and (${query.scope ?? null}::text is null or r.scope = ${query.scope ?? null})
						order by r.type limit ${limit + 1}`;
				const selected = types.slice(0, limit).map(({ type }) => type);
				if (selected.length === 0) return { types, rows: [], rates: [] };
				const rows = await tx<
					{
						type: string;
						scope: string;
						first_seen: string;
						last_emit: string | null;
						dimensions: SemanticShape["dimensions"];
						measures: SemanticShape["measures"];
						joins: SemanticShape["joins"];
						emit_count: string;
						updated_at: string;
					}[]
				>`select * from semantic_registry_scoped where type = any(${tx.array(selected)})
					  order by type, scope`;
				const rates = await tx<{ type: string; rate: number }[]>`
						select type, count(*)::float8 / 5 as rate from events
						where type = any(${tx.array(selected)})
						  and received_at >= now() - interval '5 minutes' group by type`;
				return { types, rows, rates };
			});
			const rateByType = new Map(page.rates.map((row) => [row.type, row.rate]));
			const items = page.types.slice(0, limit).map(({ type }) => {
				const rows = page.rows.filter((row) => row.type === type);
				let shape: SemanticShape = { dimensions: {}, measures: {}, joins: [] };
				for (const row of rows) shape = mergeSemanticShape(shape, row).shape;
				return {
					type,
					first_seen: rows.map((row) => row.first_seen).toSorted()[0],
					last_emit:
						rows
							.map((row) => row.last_emit)
							.filter((value): value is string => value !== null)
							.toSorted()
							.at(-1) ?? null,
					dimensions: shape.dimensions,
					measures: shape.measures,
					joins: shape.joins,
					scopes: rows.map((row) => row.scope).toSorted(),
					emit_count: rows.reduce((sum, row) => sum + Number(row.emit_count), 0),
					emit_rate_per_min: rateByType.get(type) ?? 0,
				};
			});
			const byteCap = 1024 * 1024;
			// Reserve a bounded margin for freshness, cursor, omitted_types, and JSON structure so the
			// advertised cap applies to the complete response rather than only its item payloads.
			const itemBudget = byteCap - 4096;
			const capped: typeof items = [];
			let bytes = 0;
			for (const item of items) {
				const nextBytes = Buffer.byteLength(JSON.stringify(item));
				if (bytes + nextBytes > itemBudget) break;
				capped.push(item);
				bytes += nextBytes;
			}
			const clippedByBytes = capped.length < items.length;
			const hasMore = page.types.length > limit || clippedByBytes;
			const firstOmitted = items[capped.length]?.type;
			const oversizedFirst = clippedByBytes && capped.length === 0;
			const cursorType = clippedByBytes ? firstOmitted : capped.at(-1)?.type;
			const observedAt =
				page.rows
					.map((row) => row.updated_at)
					.toSorted()
					.at(-1) ?? new Date().toISOString();
			return jsonResponse(200, {
				schema_version: 1,
				freshness: { source: "semantic-registry", observed_at: observedAt, window_s: null },
				items: capped,
				next_cursor: hasMore
					? cursorType
						? catalogCursor(cursorType, clippedByBytes && !oversizedFirst)
						: null
					: null,
				truncated: hasMore,
				...(oversizedFirst && firstOmitted ? { omitted_types: [firstOmitted] } : {}),
			});
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/catalog/search",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const query = queryOf(ctx.url) as { q?: string; limit?: string };
			if (!query.q || query.q.length > 512)
				return jsonResponse(400, {
					error: { code: "bad_search", message: "q is required (max 512 chars)", retryable: false },
				});
			const items = await searchSemanticCorpus(
				services.db.app,
				p.scopes,
				query.q,
				Number(query.limit ?? 8),
			);
			return jsonResponse(200, { schema_version: 1, items });
		},
	});

	// --- global command palette ------------------------------------------------------------------
	// One scope-filtered retrieval seam for the shell. Surfaces and safe quick actions stay local
	// (they are static capability-aware navigation); operational objects are always read as-caller.
	route({
		method: "GET",
		pattern: "/api/v1/palette/search",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const query = queryOf(ctx.url) as Record<string, unknown>;
			const text = typeof query["q"] === "string" ? query["q"].trim() : "";
			if (!text || text.length > 100)
				return jsonResponse(400, {
					error: {
						code: "bad_palette_query",
						message: "q is required (max 100 chars)",
						retryable: false,
					},
				});
			const rawLimit = query["limit"];
			if (
				rawLimit !== undefined &&
				(typeof rawLimit !== "string" ||
					!/^\d+$/.test(rawLimit) ||
					Number(rawLimit) < 1 ||
					Number(rawLimit) > 32)
			)
				return jsonResponse(400, {
					error: {
						code: "bad_palette_query",
						message: "limit must be an integer from 1 to 32",
						retryable: false,
					},
				});
			const limit = rawLimit === undefined ? 24 : Number(rawLimit);
			const [agents, tasks, library, hosts, statistics] = await Promise.allSettled([
				Promise.resolve().then(() =>
					services.tracker ? readAgents(services.tracker, principal.scopes).items : [],
				),
				Promise.resolve().then(() =>
					services.tracker ? readTasks(services.tracker, principal.scopes).items : [],
				),
				searchLibraryPaletteItems(services.db.app, principal.scopes, text, limit),
				searchEntity(services.db.app, principal.scopes, "box_update", text, limit),
				searchSemanticCorpus(services.db.app, principal.scopes, text, limit, "statistic"),
			]);

			const candidates: PaletteCandidate[] = [];
			if (agents.status === "fulfilled") {
				for (const agent of agents.value) {
					const handle = formatUnknown(agent["handle"] ?? "");
					if (!handle) continue;
					const displayName = formatUnknown(agent["display_name"] ?? handle);
					const host = typeof agent["host"] === "string" ? agent["host"] : null;
					const role = typeof agent["role"] === "string" ? agent["role"] : "agent";
					candidates.push({
						id: `agent:${handle}`,
						kind: "agent",
						label: displayName,
						description: `@${handle} · ${role}${host ? ` · ${host}` : ""}`,
						href: `/agents?agent=${encodeURIComponent(handle)}`,
						keywords: [handle, role, host ?? "", formatUnknown(agent["capabilities"] ?? "")],
						meta: agent["active"] === 0 ? "inactive" : "resident",
					});
				}
			}
			if (tasks.status === "fulfilled") {
				for (const task of tasks.value) {
					const id = Number(task["id"]);
					const title = formatUnknown(task["title"] ?? "");
					if (!Number.isSafeInteger(id) || id < 1 || !title) continue;
					const status = formatUnknown(task["status"] ?? "unknown");
					const project = typeof task["project_name"] === "string" ? task["project_name"] : null;
					const owner = formatUnknown(
						task["claimed_by"] ?? task["assignee"] ?? task["owner"] ?? "unassigned",
					);
					candidates.push({
						id: `task:${String(id)}`,
						kind: "task",
						label: title,
						description: `/task/${String(id)} · ${status}${project ? ` · ${project}` : ""}`,
						href: `/work?task=${String(id)}`,
						keywords: [String(id), status, project ?? "", owner],
						meta: owner,
					});
				}
			}
			if (library.status === "fulfilled") {
				const items = Array.isArray(library.value["items"])
					? (library.value["items"] as Record<string, unknown>[])
					: [];
				for (const item of items) {
					const id = formatUnknown(item["id"] ?? "");
					const title = formatUnknown(item["title"] ?? "");
					if (!id || !title) continue;
					const kind = formatUnknown(item["kind"] ?? "item");
					const project = formatUnknown(item["project"] ?? "unfiled");
					candidates.push({
						id: `library:${id}`,
						kind: "library",
						label: title,
						description: `${kind} · ${project}`,
						href: `/library?item=${encodeURIComponent(id)}`,
						keywords: [id, kind, project, formatUnknown(item["status"] ?? "")],
						meta: formatUnknown(item["status"] ?? ""),
					});
				}
			}
			if (hosts.status === "fulfilled") {
				for (const host of hosts.value.items) {
					const hostname = formatUnknown(
						host["hostname"] ?? host["box_id"] ?? host["subject"] ?? "",
					);
					if (!hostname) continue;
					const status = formatUnknown(host["status"] ?? "unknown").replaceAll("_", " ");
					candidates.push({
						id: `host:${hostname}`,
						kind: "host",
						label: hostname,
						description: `Host · ${status}`,
						href: `/hosts?host=${encodeURIComponent(hostname)}`,
						keywords: [
							formatUnknown(host["box_id"] ?? ""),
							status,
							formatUnknown(host["os_family"] ?? ""),
						],
						meta: formatUnknown(host["last_checked_at"] ?? host["observed_at"] ?? ""),
					});
				}
			}
			if (statistics.status === "fulfilled") {
				for (const statistic of statistics.value) {
					if (statistic.kind !== "statistic") continue;
					candidates.push({
						id: `statistic:${statistic.source_ref}`,
						kind: "statistic",
						label: statistic.source_ref,
						description: statistic.content.slice(0, 120),
						href: `/observability?stat=${encodeURIComponent(statistic.source_ref)}`,
						keywords: [statistic.kind, statistic.content],
						meta: statistic.kind,
					});
				}
			}

			const sourceRanked = ["agent", "task", "library", "host", "statistic"].flatMap((kind) =>
				rankPaletteCandidates(
					text,
					candidates.filter((candidate) => candidate.kind === kind),
					limit,
				),
			);
			return jsonResponse(200, {
				schema_version: 1,
				freshness: { source: "palette", observed_at: new Date().toISOString(), window_s: 0 },
				query: text,
				items: rankPaletteCandidates(text, sourceRanked, limit),
				sources: {
					agents: agents.status === "fulfilled" && services.tracker ? "live" : "unavailable",
					tasks: tasks.status === "fulfilled" && services.tracker ? "live" : "unavailable",
					library: library.status === "fulfilled" ? "live" : "unavailable",
					hosts: hosts.status === "fulfilled" ? "live" : "unavailable",
					statistics: statistics.status === "fulfilled" ? "live" : "unavailable",
				},
			});
		},
	});

	// --- typed entity reads (RLS-scoped projections, N1b) -----------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/availability",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const requested = (queryOf(ctx.url) as { window?: string }).window ?? "30d";
			const windows: Readonly<Record<string, number>> = {
				"24h": 86_400,
				"7d": 7 * 86_400,
				"30d": 30 * 86_400,
			};
			const windowS = windows[requested];
			if (!windowS)
				return jsonResponse(400, {
					error: {
						code: "bad_window",
						message: "window must be one of 24h, 7d, or 30d",
						retryable: false,
					},
				});
			return jsonResponse(200, await readAvailability(services.db.app, principal.scopes, windowS));
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/comms",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const query = queryOf(ctx.url) as {
				type?: string;
				agent?: string;
				task_id?: string;
				limit?: string;
				cursor?: string;
			};
			const types = new Set<CommsType>(["task-card", "rpc", "mail"]);
			if (query.type && !types.has(query.type as CommsType))
				return jsonResponse(400, {
					error: {
						code: "bad_comms_type",
						message: "type must be task-card, rpc, or mail",
						retryable: false,
					},
				});
			if (query.agent && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(query.agent))
				return jsonResponse(400, {
					error: {
						code: "bad_comms_agent",
						message: "agent must be a resident or service handle",
						retryable: false,
					},
				});
			const taskId = query.task_id === undefined ? undefined : Number(query.task_id);
			if (taskId !== undefined && (!Number.isSafeInteger(taskId) || taskId <= 0))
				return jsonResponse(400, {
					error: {
						code: "bad_comms_task",
						message: "task_id must be a positive integer",
						retryable: false,
					},
				});
			if (query.cursor !== undefined && decodeCommsCursor(query.cursor) === null)
				return jsonResponse(400, {
					error: {
						code: "bad_comms_cursor",
						message: "cursor is invalid",
						retryable: false,
					},
				});
			const limit = query.limit === undefined ? undefined : Number(query.limit);
			if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
				return jsonResponse(400, {
					error: {
						code: "bad_comms_limit",
						message: "limit must be a positive integer",
						retryable: false,
					},
				});
			return jsonResponse(
				200,
				await readCommsLog(services.db.app, principal.scopes, {
					...(query.type ? { type: query.type as CommsType } : {}),
					...(query.agent ? { agent: query.agent } : {}),
					...(taskId !== undefined ? { taskId } : {}),
					...(limit !== undefined ? { limit } : {}),
					...(query.cursor ? { cursor: query.cursor } : {}),
				}),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/signal-sources",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const opts = readOpts(queryOf(ctx.url), { path: "signal-sources", kind: "fleet" });
			if (!opts)
				return jsonResponse(400, {
					error: {
						code: "bad_since",
						message: "since must be an RFC 3339 timestamp",
						retryable: false,
					},
				});
			return jsonResponse(
				200,
				await readSignalSourceModes(services.db.app, principal.scopes, opts),
			);
		},
	});
	for (const entityRoute of ENTITY_ROUTES) {
		route({
			method: "GET",
			pattern: `/api/v1/${entityRoute.path}`,
			auth: true,
			handler: async (ctx) => {
				const principal = ctx.principal;
				const opts = readOpts(queryOf(ctx.url), entityRoute);
				if (!opts)
					return jsonResponse(400, {
						error: {
							code: "bad_since",
							message: "since must be an RFC 3339 timestamp",
							retryable: false,
						},
					});
				if (!entityRoute.typed)
					return jsonResponse(
						200,
						await readEntity(services.db.app, principal.scopes, entityRoute.kind, opts),
					);
				const result =
					entityRoute.kind === "delivery_config"
						? readDeliveryConfig(services.db.app, principal.scopes, opts)
						: readTypedEntity(services.db.app, principal.scopes, entityRoute.kind, opts);
				const envelope = await result;
				if (entityRoute.kind !== "attention") return jsonResponse(200, envelope);
				return jsonResponse(200, {
					...envelope,
					items: envelope.items.filter(
						(item) => typeof item["lane"] !== "string" || principal.lanes.includes(item["lane"]),
					),
				});
			},
		});
	}
	route({
		method: "GET",
		pattern: "/api/v1/box-updates/:boxId/raw",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const { boxId } = ctx.params as { boxId: string };
			const raw = await readBoxUpdateRaw(services.db.app, principal.scopes, boxId);
			if (raw) return jsonResponse(200, raw);
			return jsonResponse(404, {
				error: {
					code: "box_update_raw_not_found",
					message: "update detail is not available",
					retryable: false,
				},
			});
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/network/key-ceremony",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const registry = await readEntity(services.db.app, principal.scopes, "edge", {
				limit: 1_000,
				requiredFields: ["pubkey_fp", "state"],
			});
			const configured = services.keyCeremony !== null;
			const live = configured ? await services.keyCeremony.health() : false;
			return jsonResponse(200, {
				schema_version: 1,
				registry,
				executor: {
					kind: "edge",
					configured,
					live,
					detail: !configured
						? "Doorman key ceremony is not configured"
						: live
							? "Doorman key ceremony answered its private health check"
							: "Doorman key ceremony is not answering",
				},
			});
		},
	});

	route({
		method: "GET",
		pattern: "/api/v1/update-approvals",
		auth: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const query = queryOf(ctx.url) as {
				box_id?: string;
				limit?: string;
				cursor?: string;
				since?: string;
			};
			const boxId = query.box_id;
			if (!boxId || boxId.length > 256)
				return jsonResponse(400, {
					error: {
						code: "bad_box_id",
						message: "box_id is required",
						retryable: false,
					},
				});
			const requestedLimit = Number(query.limit ?? 200);
			if (
				!Number.isInteger(requestedLimit) ||
				requestedLimit < 1 ||
				requestedLimit > 1000 ||
				(query.cursor && !z.uuid().safeParse(query.cursor).success) ||
				(query.since && Number.isNaN(Date.parse(query.since)))
			)
				return jsonResponse(400, {
					error: {
						code: "bad_pagination",
						message: "limit, cursor, or since is invalid",
						retryable: false,
					},
				});
			const limit = requestedLimit;
			const cursor = query.cursor ?? null;
			const since = query.since ?? null;
			const items = await withScopes(
				services.db.app,
				principal.scopes,
				async (tx) =>
					tx<
						{
							approval_id: string;
							box_id: string;
							packages: string[];
							approved_by: string;
							approved_at: string;
							revocable: boolean;
							observed_at: string;
						}[]
					>`
						select approved.dimensions->>'approval_id' as approval_id,
						       approved.subject as box_id,
						       coalesce(approved.meta->'packages', '[]'::jsonb) as packages,
						       approved.dimensions->>'approved_by' as approved_by,
						       approved.ts::text as approved_at,
						       true as revocable,
						       approved.received_at::text as observed_at
						from lake_events approved
						where approved.type = 'updates.approved'
						  and approved.subject = ${boxId}
						  and (${since}::timestamptz is null or approved.received_at >= ${since}::timestamptz)
						  and (${cursor}::uuid is null or approved.seq < coalesce((
						    select cursor_event.seq from lake_events cursor_event
						    where cursor_event.type = 'updates.approved'
						      and cursor_event.dimensions->>'approval_id' = ${cursor}
						    limit 1
						  ), 0))
						  and not exists (
						    select 1 from lake_events later
						    where (
						      later.type in ('updates.approval_revoked', 'updates.applied')
						      and later.dimensions->>'approval_id' = approved.dimensions->>'approval_id'
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
						order by approved.seq desc limit ${limit + 1}`,
			);
			const rowTruncated = items.length > limit;
			const candidates = (rowTruncated ? items.slice(0, limit) : items).map((item) => ({
				...item,
				approved_at: new Date(item.approved_at).toISOString(),
				observed_at: new Date(item.observed_at).toISOString(),
			}));
			const page: typeof candidates = [];
			let serializedBytes = 512;
			const responseByteCap = 1_000_000;
			for (const item of candidates) {
				const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
				if (page.length > 0 && serializedBytes + itemBytes > responseByteCap) break;
				page.push(item);
				serializedBytes += itemBytes;
			}
			const truncated = rowTruncated || page.length < candidates.length;
			return jsonResponse(200, {
				schema_version: 1,
				freshness: {
					source: "updates approval ledger",
					observed_at: page.reduce(
						(newest, item) => (item.observed_at > newest ? item.observed_at : newest),
						"1970-01-01T00:00:00Z",
					),
					window_s: null,
				},
				items: page,
				next_cursor: truncated ? (page.at(-1)?.approval_id ?? null) : null,
				truncated,
			});
		},
	});

	// --- tracker-sourced reads (single-writer store, mapped to console scope, N1b-2) -------------
	route({
		method: "GET",
		pattern: "/api/v1/tasks",
		auth: true,
		handler: (ctx) => {
			const unavailable = trackerUnavailable();
			if (unavailable) return unavailable;
			return jsonResponse(200, readTasks(services.tracker as TrackerReader, ctx.principal.scopes));
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/work/settlement",
		auth: true,
		handler: (ctx) => {
			const unavailable = trackerUnavailable();
			if (unavailable) return unavailable;
			return jsonResponse(
				200,
				readWorkSettlement(services.tracker as TrackerReader, ctx.principal.scopes),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/leases",
		auth: true,
		handler: (ctx) => {
			const unavailable = trackerUnavailable();
			if (unavailable) return unavailable;
			return jsonResponse(200, readLeases(services.tracker as TrackerReader, ctx.principal.scopes));
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/agents",
		auth: true,
		handler: (ctx) => {
			const unavailable = trackerUnavailable();
			if (unavailable) return unavailable;
			return jsonResponse(200, readAgents(services.tracker as TrackerReader, ctx.principal.scopes));
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/roster",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			return jsonResponse(200, await readRoster(services.db.app, services.tracker, p.scopes));
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/executors",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			return jsonResponse(200, await readExecutors(services.db.app, p.scopes));
		},
	});

	// --- terminal gate + frame transport --------------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/terminal",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const denial = await authorizeTerminal(principal);
			if (denial) {
				const auditSeq = await emitTerminalAudit(principal, "denied", null, null, denial);
				if (auditSeq === null)
					return jsonResponse(503, {
						error: {
							code: "audit_unavailable",
							message: "terminal denial could not be retained",
							retryable: true,
						},
					});
				return jsonResponse(403, {
					error: { code: "term_denied", message: "term_admin access required", retryable: false },
				});
			}
			const auditSeq = await emitTerminalAudit(principal, "access", null, null);
			if (auditSeq === null)
				return jsonResponse(503, {
					error: {
						code: "audit_unavailable",
						message: "terminal audit write could not be verified",
						retryable: true,
					},
				});
			return jsonResponse(200, {
				audit_writable: true,
				pty_live: await terminal.health(),
				audit_seq: auditSeq,
			});
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/terminal/peek",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const denial = await authorizeTerminal(principal);
			if (denial) {
				const auditSeq = await emitTerminalAudit(principal, "denied", null, null, denial);
				return jsonResponse(auditSeq === null ? 503 : 403, {
					error: {
						code: auditSeq === null ? "audit_unavailable" : "term_denied",
						message: auditSeq === null ? "terminal denial could not be retained" : denial,
						retryable: auditSeq === null,
					},
				});
			}
			const parsed = terminalTargetSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: { code: "invalid_target", message: "invalid terminal target", retryable: false },
				});
			if (!(await terminal.health()))
				return jsonResponse(503, {
					error: { code: "pty_unavailable", message: "PTY adapter unavailable", retryable: true },
				});
			const streamId = crypto.randomUUID();
			const target: TerminalTarget = {
				host: parsed.data.host,
				tmuxSession: parsed.data.tmux_session,
				paneId: parsed.data.pane_id,
			};
			if (!(await visibleResidentTarget(principal, target)))
				return jsonResponse(404, {
					error: {
						code: "pane_not_visible",
						message: "resident terminal pane is not visible",
						retryable: false,
					},
				});
			const auditSeq = await emitTerminalAudit(principal, "watch", target, streamId);
			if (auditSeq === null)
				return jsonResponse(503, {
					error: {
						code: "audit_unavailable",
						message: "watch audit could not be retained",
						retryable: true,
					},
				});
			const session: TerminalSession = {
				principalId: principal.id,
				target,
				writable: false,
				attached: false,
				closed: false,
				seq: 0,
				timer: null,
				end: () => {},
			};
			terminalSessions.set(streamId, session);
			session.timer = setTimeout(() => {
				session.closed = true;
				terminalSessions.delete(streamId);
			}, 30_000);
			session.timer.unref();
			try {
				const snapshot = await terminal.capture(target, parsed.data.scrollback_lines);
				session.seq += 1;
				return jsonResponse(200, {
					schema_version: 1,
					stream_id: streamId,
					seq: session.seq,
					audit_seq: auditSeq,
					data_b64: snapshot.toString("base64"),
				});
			} catch (error) {
				clearTimeout(session.timer);
				terminalSessions.delete(streamId);
				monitor.captureException(sanitizedException(error));
				return jsonResponse(502, {
					error: {
						code: "pty_capture_failed",
						message: "terminal capture failed",
						retryable: true,
					},
				});
			}
		},
	});

	route({
		method: "GET",
		pattern: "/api/v1/terminal/peek/:streamId",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const owned = await ownedTerminalSession(ctx.principal, ctx.params["streamId"]);
			if (owned instanceof Response) return owned;
			const session = owned;
			if (session.timer) clearTimeout(session.timer);
			session.timer = setTimeout(() => {
				session.closed = true;
				terminalSessions.delete((ctx.params as { streamId: string }).streamId);
			}, 30_000);
			session.timer.unref();
			try {
				const snapshot = await terminal.capture(session.target, 10_000);
				session.seq += 1;
				return jsonResponse(200, {
					schema_version: 1,
					stream_id: (ctx.params as { streamId: string }).streamId,
					seq: session.seq,
					data_b64: snapshot.toString("base64"),
				});
			} catch (error) {
				monitor.captureException(sanitizedException(error));
				return jsonResponse(502, {
					error: {
						code: "pty_capture_failed",
						message: "terminal capture failed",
						retryable: true,
					},
				});
			}
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/terminal/streams",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const principal = ctx.principal;
			const denial = await authorizeTerminal(principal);
			if (denial) {
				const auditSeq = await emitTerminalAudit(principal, "denied", null, null, denial);
				return jsonResponse(auditSeq === null ? 503 : 403, {
					error: {
						code: auditSeq === null ? "audit_unavailable" : "term_denied",
						message: auditSeq === null ? "terminal denial could not be retained" : denial,
						retryable: auditSeq === null,
					},
				});
			}
			const parsed = terminalTargetSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: { code: "invalid_target", message: "invalid terminal target", retryable: false },
				});
			if (!(await terminal.health()))
				return jsonResponse(503, {
					error: { code: "pty_unavailable", message: "PTY adapter unavailable", retryable: true },
				});
			const streamId = crypto.randomUUID();
			const target: TerminalTarget = {
				host: parsed.data.host,
				tmuxSession: parsed.data.tmux_session,
				paneId: parsed.data.pane_id,
			};
			// The retained watch audit is the hard boundary: no response frame or ssh call occurs first.
			const auditSeq = await emitTerminalAudit(principal, "watch", target, streamId);
			if (auditSeq === null)
				return jsonResponse(503, {
					error: {
						code: "audit_unavailable",
						message: "watch audit could not be retained",
						retryable: true,
					},
				});
			const session: TerminalSession = {
				principalId: principal.id,
				target,
				writable: true,
				attached: false,
				closed: false,
				seq: 0,
				timer: null,
				end: () => {},
			};
			terminalSessions.set(streamId, session);
			const requestHeaders = ctx.request.headers;
			const requestHostname = ctx.url.hostname;
			const encoder = new TextEncoder();
			const close = (): void => {
				session.closed = true;
				if (session.timer) clearTimeout(session.timer);
				terminalSessions.delete(streamId);
			};
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					let streamEnded = false;
					// Web streams have no drain signal: enqueued frames buffer internally, and the 750ms
					// pacing timer plus dedupe of unchanged snapshots bound queue growth.
					const write = (frame: Record<string, unknown>): void => {
						if (streamEnded) return;
						try {
							controller.enqueue(
								encoder.encode(
									`${JSON.stringify({ schema_version: 1, stream_id: streamId, ...frame })}\n`,
								),
							);
						} catch {
							/* the client cancelled mid-frame; close() cleanup already ran */
						}
					};
					const end = (): void => {
						if (!streamEnded) {
							streamEnded = true;
							try {
								controller.close();
							} catch {
								/* already closed by cancel() */
							}
						}
						close();
					};
					write({ kind: "open", seq: session.seq, audit_seq: auditSeq, mode: "read" });
					let previous: Buffer | null = null;
					const pump = async (): Promise<void> => {
						if (session.closed || streamEnded) return;
						try {
							const fresh = await resolvePrincipal(requestHeaders, requestHostname);
							const revoked =
								!fresh ||
								fresh.id !== session.principalId ||
								(await authorizeTerminal(fresh)) !== null;
							if (revoked) {
								session.closed = true;
								session.seq += 1;
								write({ kind: "error", seq: session.seq, code: "terminal_access_revoked" });
								if (fresh)
									await emitTerminalAudit(
										fresh,
										"denied",
										target,
										streamId,
										"stream authorization revoked",
									);
								end();
								return;
							}
							const frame = await terminal.capture(target, parsed.data.scrollback_lines);
							if (!previous?.equals(frame)) {
								previous = frame;
								session.seq += 1;
								write({ kind: "snapshot", seq: session.seq, data_b64: frame.toString("base64") });
							}
						} catch (error) {
							monitor.captureException(sanitizedException(error));
							session.closed = true;
							session.seq += 1;
							write({ kind: "error", seq: session.seq, code: "pty_capture_failed" });
							end();
							return;
						}
						session.timer = setTimeout(() => void pump(), 750);
					};
					void pump();
					session.end = end;
				},
				cancel: () => {
					close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: {
					"cache-control": "no-store",
					"content-type": "application/x-ndjson; charset=utf-8",
					"x-accel-buffering": "no",
				},
			});
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/terminal/streams/:streamId/attach",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const owned = await ownedTerminalSession(ctx.principal, ctx.params["streamId"]);
			if (owned instanceof Response) return owned;
			const session = owned;
			if (!session.writable)
				return jsonResponse(409, {
					error: {
						code: "watch_only",
						message: "read-only peek sessions cannot attach",
						retryable: false,
					},
				});
			const principal = ctx.principal;
			const streamId = (ctx.params as { streamId: string }).streamId;
			const auditSeq = await emitTerminalAudit(principal, "attach", session.target, streamId);
			if (auditSeq === null)
				return jsonResponse(503, {
					error: { code: "audit_unavailable", message: "attach audit failed", retryable: true },
				});
			session.attached = true;
			return jsonResponse(200, { ok: true, mode: "write", audit_seq: auditSeq });
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/terminal/streams/:streamId/input",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const owned = await ownedTerminalSession(ctx.principal, ctx.params["streamId"]);
			if (owned instanceof Response) return owned;
			const session = owned;
			if (!session.attached)
				return jsonResponse(409, {
					error: { code: "watch_only", message: "attach before sending input", retryable: false },
				});
			const parsed = terminalInputSchema.safeParse(ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: { code: "invalid_input", message: "invalid terminal input", retryable: false },
				});
			const data = Buffer.from(parsed.data.data_b64, "base64");
			if (data.length > 16_384)
				return jsonResponse(413, {
					error: { code: "input_too_large", message: "terminal input too large", retryable: false },
				});
			const principal = ctx.principal;
			const streamId = (ctx.params as { streamId: string }).streamId;
			const auditSeq = await emitTerminalAudit(principal, "input", session.target, streamId);
			if (auditSeq === null)
				return jsonResponse(503, {
					error: { code: "audit_unavailable", message: "input audit failed", retryable: true },
				});
			try {
				await terminal.input(session.target, data);
				return jsonResponse(200, { ok: true, audit_seq: auditSeq });
			} catch (error) {
				monitor.captureException(sanitizedException(error));
				return jsonResponse(503, {
					error: { code: "pty_input_failed", message: "terminal input failed", retryable: true },
				});
			}
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/terminal/streams/:streamId/detach",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const owned = await ownedTerminalSession(ctx.principal, ctx.params["streamId"]);
			if (owned instanceof Response) return owned;
			const session = owned;
			const principal = ctx.principal;
			const streamId = (ctx.params as { streamId: string }).streamId;
			const auditSeq = await emitTerminalAudit(principal, "detach", session.target, streamId);
			if (auditSeq === null)
				return jsonResponse(503, {
					error: { code: "audit_unavailable", message: "detach audit failed", retryable: true },
				});
			session.closed = true;
			if (session.timer) clearTimeout(session.timer);
			terminalSessions.delete(streamId);
			session.end();
			return jsonResponse(200, { ok: true, audit_seq: auditSeq });
		},
	});

	function matchRoute(
		method: string,
		pathname: string,
	): { def: RouteDef; params: Record<string, string> } | null {
		const parts = pathname.split("/");
		for (const def of routes) {
			if (def.method !== method) continue;
			const patternParts = def.pattern.split("/");
			if (patternParts.length !== parts.length) continue;
			const params: Record<string, string> = {};
			let matched = true;
			for (let index = 0; index < patternParts.length; index += 1) {
				const patternPart = patternParts[index];
				const part = parts[index];
				if (patternPart.startsWith(":")) {
					try {
						params[patternPart.slice(1)] = decodeURIComponent(part);
					} catch {
						matched = false;
						break;
					}
				} else if (patternPart !== part) {
					matched = false;
					break;
				}
			}
			if (matched) return { def, params };
		}
		return null;
	}

	async function dispatch(
		request: Request,
		url: URL,
		match: { def: RouteDef; params: Record<string, string> } | null,
	): Promise<Response> {
		if (browserOrigin) {
			const origin = request.headers.get("origin");
			if (origin && origin !== browserOrigin)
				return jsonResponse(403, {
					error: { code: "origin_denied", message: "origin is not allowed", retryable: false },
				});
			// @fastify/cors strict-preflight parity: an OPTIONS request carrying both Origin and
			// Access-Control-Request-Method is answered here, before routing.
			if (
				request.method === "OPTIONS" &&
				origin &&
				request.headers.get("access-control-request-method")
			)
				return new Response(null, {
					status: 204,
					headers: {
						"access-control-allow-origin": browserOrigin,
						"access-control-allow-credentials": "true",
						"access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
						"access-control-allow-headers": "accept, authorization, content-type",
						vary: "origin",
					},
				});
		}
		if (!match)
			return jsonResponse(404, {
				error: { code: "not_found", message: "route not found", retryable: false },
			});
		let body: unknown;
		if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
			const text = await request.text();
			if (Buffer.byteLength(text) > 1024 * 1024)
				return jsonResponse(413, {
					error: {
						code: "body_too_large",
						message: "request body exceeds limit",
						retryable: false,
					},
				});
			if (text && (request.headers.get("content-type") ?? "").includes("application/json")) {
				try {
					body = JSON.parse(text) as unknown;
				} catch {
					return jsonResponse(400, {
						error: { code: "bad_request", message: "invalid JSON body", retryable: false },
					});
				}
			}
		}
		const base = { request, url, params: match.params, route: match.def.pattern, body };
		if (!match.def.auth) return match.def.handler(base);
		const principal = await resolvePrincipal(request.headers, url.hostname);
		if (!principal)
			return jsonResponse(401, {
				error: { code: "unauthorized", message: "valid credentials required", retryable: false },
			});
		if (match.def.rateLimit) {
			const limited = opRateLimit(principal);
			if (limited) return limited;
		}
		return match.def.handler({ ...base, principal });
	}

	async function fetchApi(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/v1/")) return null;
		const started = performance.now();
		const match = matchRoute(request.method, url.pathname);
		let response: Response;
		try {
			response = await dispatch(request, url, match);
		} catch (error) {
			monitor.captureException(sanitizedException(error));
			await emitSelf({
				schema_version: 1,
				id: crypto.randomUUID(),
				type: "console.api.error",
				ts: new Date().toISOString(),
				source: { service: "console-api", host: null, agent: null },
				subject: "console-api",
				subject_kind: "service",
				severity: "danger",
				scope: "fleet",
				dimensions: {
					method: request.method,
					...(match ? { route: match.def.pattern } : {}),
					error_class: error instanceof Error ? error.constructor.name : "UnknownError",
				},
			});
			response = jsonResponse(500, {
				error: { code: "internal_error", message: "internal server error", retryable: true },
			});
		}
		// Successful self-observation is sampled 1:10; every failed request is retained. Only bounded
		// metadata is captured — never Authorization, request bodies, term input, or response bodies.
		// Fired post-response like Fastify's onResponse hook: the caller never waits on telemetry.
		requestSample += 1;
		if (response.status >= 400 || requestSample % 10 === 0)
			void emitSelf({
				schema_version: 1,
				id: crypto.randomUUID(),
				type: "console.api.request",
				ts: new Date().toISOString(),
				source: { service: "console-api", host: null, agent: null },
				subject: "console-api",
				subject_kind: "service",
				severity: response.status >= 500 ? "danger" : "info",
				scope: "fleet",
				dimensions: {
					method: request.method,
					...(match ? { route: match.def.pattern } : {}),
					status: String(response.status),
				},
				measures: {
					duration_ms: Math.max(0, performance.now() - started),
				},
			});
		if (browserOrigin && request.headers.get("origin") === browserOrigin) {
			response.headers.set("access-control-allow-origin", browserOrigin);
			response.headers.set("access-control-allow-credentials", "true");
			response.headers.set("vary", "origin");
		}
		return response;
	}

	return {
		fetch: fetchApi,
		resolvePrincipal,
		busCounters,
		close() {
			for (const session of terminalSessions.values()) {
				session.closed = true;
				if (session.timer) clearTimeout(session.timer);
			}
			terminalSessions.clear();
		},
	};
}
