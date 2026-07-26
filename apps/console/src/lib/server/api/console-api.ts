// The HTTP surface (contract §1.1), folded out of the legacy standalone server into a framework-agnostic
// Web-standard router: a bearer/dev auth chain that resolves a server-stamped Principal, then the
// four-plane routes. Query, Command, and the current Library seam are all served here (the bus
// rides the host's WebSocket upgrade path via bus/connection.ts); unavailable executor adapters
// fail closed. Behavior is byte-compatible with the former buildServer: status codes, error
// codes, bodies, and headers are unchanged.
import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";

import { asynchronously } from "#domain/iteration";
import { required } from "#format";

import { flattenRosterItem } from "../../api/derive.ts";
import { QueryRequestSchema } from "../domain/api-schema.ts";
import { ask } from "../domain/assistant/engine.ts";
import { AssistantRuntimeError } from "../domain/assistant/runtime.ts";
import { handleAssistantMcp, resolveAssistantToolPrincipal } from "../domain/assistant/tools.ts";
import { resolveBrowserPrincipal } from "../domain/auth/browser-principal.ts";
import {
	canViewGrantObject,
	GrantError,
	grantMutationSchema,
	listGrants,
	mutateGrant,
} from "../domain/auth/grants.ts";
import { resolveBearer, devPrincipal, type Principal } from "../domain/auth/principal.ts";
import { ProposalError } from "../domain/auth/proposals.ts";
import type { BetterAuthSessionVerifier } from "../domain/auth/session.ts";
import { listTiers } from "../domain/auth/tiers.ts";
import { readAvailability } from "../domain/availability/service.ts";
import type { BusCounters } from "../domain/bus/connection.ts";
import { executeOpPlane, maybePropose } from "../domain/commands/op-plane.ts";
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
	saveDashboard,
	setHomeDashboard,
} from "../domain/dashboard/store.ts";
import { withScopes } from "../domain/db/pool.ts";
import { scrubUnknown } from "../domain/ingest/scrubber.ts";
import {
	inertExceptionMonitor,
	reportSelfEmissionFailure,
	sanitizedException,
	type ExceptionMonitor,
} from "../domain/observability.ts";
import { consumeOpRateLimit } from "../domain/op-rate-limit.ts";
import { searchPalette } from "../domain/palette/service.ts";
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
	type ReadOpts,
	readTypedEntity,
} from "../domain/reads/entities.ts";
import { readRoster, readExecutors } from "../domain/reads/roster.ts";
import { readTasks, readLeases, readAgents } from "../domain/reads/tracker-reads.ts";
import type { TrackerReader } from "../domain/reads/tracker.ts";
import { readWorkSettlement } from "../domain/reads/work-settlement.ts";
import { acquireCapability, CapabilityAcquisitionError } from "../domain/registry/acquisition.ts";
import { materializePanel } from "../domain/render/engine.ts";
import type { PanelSpecV2 } from "../domain/render/types.ts";
import {
	dashboardSaveSchema,
	investigationBranchSchema,
	renderRequestSchema,
	selectedMarkSchema,
} from "../domain/render/validation.ts";
import { rejectUnknownKeys, UUID_RE } from "../domain/schema-conventions.ts";
import { mergeSemanticShape, type SemanticShape } from "../domain/semantic/registry.ts";
import { searchSemanticCorpus } from "../domain/semantic/search.ts";
import type { Services } from "../domain/substrate.ts";
import {
	TerminalDomainError,
	terminalService,
	type TerminalAdapter,
	type TerminalSession,
	type TerminalTarget,
	UnavailableTerminalAdapter,
} from "../domain/terminal/service.ts";
import { readUpdateApprovals } from "../domain/updates/approvals.ts";

export type { TerminalAdapter, TerminalTarget } from "../domain/terminal/service.ts";

const askRequestSchema = Schema.Struct({
	question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
}).annotate(rejectUnknownKeys);
const assistantMessageSchema = Schema.Struct({
	id: Schema.String.check(Schema.isUUID()),
	message: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(100_000),
		Schema.isPattern(/\S/),
	),
}).annotate(rejectUnknownKeys);
const assistantContextSchema = Schema.Struct({
	id: Schema.String.check(Schema.isUUID()),
	payload: Schema.Struct({
		...selectedMarkSchema.fields,
		value: Schema.Unknown.check(
			Schema.makeFilter((value) => value !== undefined || "value is required"),
		),
	}).annotate(rejectUnknownKeys),
}).annotate(rejectUnknownKeys);
const dashboardPinSchema = Schema.Struct({
	id: Schema.String.check(Schema.isUUID()),
}).annotate(rejectUnknownKeys);
const capabilityAcquireBodySchema = Schema.Struct({
	provider: Schema.optional(Schema.String),
}).annotate(rejectUnknownKeys);

/** Zod `safeParse` parity over Effect Schema, preserving `{ success, data }` call sites. */
function safeDecode<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: unknown,
):
	| { readonly success: true; readonly data: S["Type"] }
	| { readonly success: false; readonly message: string } {
	const exit = Schema.decodeUnknownExit(schema)(input);
	if (Exit.isSuccess(exit)) return { success: true, data: exit.value };
	const failure = Cause.squash(exit.cause);
	return { success: false, message: failure instanceof Error ? failure.message : String(failure) };
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

function runtimeFailure(error: AssistantRuntimeError): Response {
	const status = error.code === "id_reused" ? 409 : error.code === "secret_detected" ? 400 : 503;
	return jsonResponse(status, {
		error: { code: error.code, message: error.message, retryable: error.retryable },
	});
}

async function libraryRead(
	read: () => Effect.Effect<Record<string, unknown>, DashboardError>,
): Promise<Response> {
	try {
		return jsonResponse(200, await Effect.runPromise(read()));
	} catch (error) {
		if (error instanceof DashboardError)
			return jsonResponse(400, {
				error: { code: error.code, message: error.message, retryable: false },
			});
		throw error;
	}
}

const terminalTargetSchema = Schema.Struct({
	host: Schema.String.check(Schema.isPattern(/^(?:\.[0-9]{1,3}|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/)),
	tmux_session: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
	pane_id: Schema.String.check(Schema.isPattern(/^%[0-9]+$/)),
	scrollback_lines: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 0, maximum: 10_000 }),
	).pipe(Schema.withDecodingDefault(Effect.succeed(500))),
}).annotate(rejectUnknownKeys);
const terminalInputSchema = Schema.Struct({
	data_b64: Schema.String.check(
		Schema.isMaxLength(65_536),
		Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
	),
}).annotate(rejectUnknownKeys);

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

/** Legacy-parity query parsing: repeated keys become arrays, `?q=` yields an empty string. */
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
	/** Principal chain: bearer → better-auth verifier → dev header. */
	resolvePrincipal(headers: Headers, hostname: string): Promise<Principal | null>;
	/**
	 * The one origin browser credentials are honored from (better-auth's console origin), or null
	 * when no browser auth is configured. The WebSocket upgrade enforces the same origin gate the
	 * HTTP dispatch applies, from this single source.
	 */
	readonly browserOrigin: string | null;
	readonly busCounters: BusCounters;
	/**
	 * Method + pattern of every registered REST route. The single source of truth the OpenAPI
	 * document is derived from (FastAPI-style), so no hand-maintained route list can drift from what
	 * the runtime actually serves.
	 */
	readonly routes: readonly { readonly method: string; readonly pattern: string }[];
	close(): void;
}

export function buildConsoleApi(services: Services, options: ConsoleApiOptions): ConsoleApi {
	const monitor = options.monitor ?? inertExceptionMonitor;
	const terminal = options.terminal ?? new UnavailableTerminalAdapter();
	const terminalDomain = terminalService(services, terminal);
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
				const principal = await resolveBrowserPrincipal(services, identity);
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

	function opRateLimit(principal: Principal): Response | null {
		const decision = consumeOpRateLimit(services, principal);
		if (!decision.allowed) {
			return jsonResponse(
				429,
				{
					error: {
						code: "rate_limited",
						message: "command request rate exceeded",
						retryable: true,
						retry_after_s: decision.retryAfterS,
					},
				},
				{ "retry-after": String(decision.retryAfterS) },
			);
		}
		return null;
	}

	const assistantToolServices = {
		...services,
		captureException(error: unknown): void {
			monitor.captureException(sanitizedException(error));
		},
		async executeMutation(
			principal: Principal,
			op: string,
			args: Record<string, unknown>,
			requestId: string = randomUUID(),
		): Promise<Record<string, unknown>> {
			const limited = opRateLimit(principal);
			if (limited) {
				const body = (await limited.json()) as { error?: { code?: string } };
				throw Object.assign(new Error("rate limited"), {
					code: body.error?.code ?? "rate_limited",
				});
			}
			const result = await Effect.runPromise(
				executeOpPlane(
					services,
					monitor,
					{ schema_version: 1, id: requestId, op, args, dry_run: false },
					principal,
				),
			);
			const envelope = result.body as {
				ok?: boolean;
				result?: Record<string, unknown> | null;
				error?: { code?: string; message?: string } | null;
			};
			if (result.status >= 400 || envelope.ok === false) {
				throw Object.assign(new Error(envelope.error?.message ?? "operation failed"), {
					code: envelope.error?.code ?? "op_failed",
				});
			}
			return envelope.result ?? result.body;
		},
	};

	const terminalSessions = terminalDomain.sessions;
	const terminalFailure = (error: unknown): Response => {
		const failure =
			error instanceof TerminalDomainError
				? error
				: new TerminalDomainError(503, "terminal_unavailable", "terminal unavailable", true);
		return jsonResponse(failure.status, {
			error: { code: failure.code, message: failure.message, retryable: failure.retryable },
		});
	};
	const emitTerminalAudit = (
		principal: Principal,
		action: "access" | "watch" | "attach" | "input" | "detach" | "denied",
		target: TerminalTarget | null,
		streamId: string | null,
		reason: string | null = null,
	): Promise<number | null> =>
		Effect.runPromise(terminalDomain.audit(principal, action, target, streamId, reason)).catch(
			() => null,
		);
	const authorizeTerminal = (principal: Principal): Promise<string | null> =>
		Effect.runPromise(terminalDomain.authorize(principal)).then(
			() => null,
			(error: unknown) =>
				error instanceof TerminalDomainError ? error.message : "terminal unavailable",
		);
	const ownedTerminalSession = async (
		principal: Principal,
		streamId: string | undefined,
	): Promise<TerminalSession | Response> => {
		try {
			return await Effect.runPromise(terminalDomain.owned(principal, streamId));
		} catch (error) {
			const failure =
				error instanceof TerminalDomainError
					? error
					: new TerminalDomainError(503, "terminal_unavailable", "terminal unavailable", true);
			return jsonResponse(failure.status, {
				error: { code: failure.code, message: failure.message, retryable: failure.retryable },
			});
		}
	};

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
			const { status, body } = await Effect.runPromise(
				executeOpPlane(services, monitor, ctx.body, ctx.principal),
			);
			return jsonResponse(status, body);
		},
	});

	// --- health (unauthenticated) --------------------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/health",
		auth: false,
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
			const parsed = safeDecode(grantMutationSchema, ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_grant",
						message: parsed.message || "invalid grant",
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
				const result = await Effect.runPromise(runStructured(services.db.app, p.scopes, body));
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
			const parsed = safeDecode(costComparisonRequestSchema, ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_cost_comparison",
						message: parsed.message || "invalid cost comparison",
						retryable: false,
					},
				});
			const principal = ctx.principal;
			try {
				return jsonResponse(
					200,
					await Effect.runPromise(
						compareCostPair(services.db.app, principal.scopes, parsed.data, services.costMeter),
					),
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
			const record = await Effect.runPromise(readQueryRecord(services.db.app, p.scopes, queryRef));
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
			const record = await Effect.runPromise(readQueryRecord(services.db.app, p.scopes, queryRef));
			if (!record)
				return jsonResponse(404, {
					error: { code: "query_not_found", message: "query ref not found", retryable: false },
				});
			try {
				return jsonResponse(
					200,
					await Effect.runPromise(runStructured(services.db.app, p.scopes, record.request)),
				);
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
			const parsed = safeDecode(askRequestSchema, ctx.body);
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
				await Effect.runPromise(
					ask(services.db, services.assistant, p.scopes, parsed.data.question.trim()),
				),
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
			const parsed = safeDecode(assistantMessageSchema, ctx.body);
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
			const parsed = safeDecode(assistantContextSchema, ctx.body);
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
						return identity ? resolveBrowserPrincipal(services, identity) : null;
					})
				: null;
			if (!principal)
				return jsonResponse(401, {
					jsonrpc: "2.0",
					id: (ctx.body as { id?: unknown } | null)?.id ?? null,
					error: { code: -32_000, message: "Unauthorized" },
				});
			return jsonResponse(
				200,
				await Effect.runPromise(handleAssistantMcp(assistantToolServices, principal, ctx.body)),
			);
		},
	});
	// Backward-compatible alias with the same tool-token contract as the canonical endpoint.
	route({
		method: "POST",
		pattern: "/api/v1/mcp",
		auth: false,
		handler: async (ctx) => {
			const match = /^Bearer\s+(\S+)$/i.exec(ctx.request.headers.get("authorization") ?? "");
			const principal = match?.[1]
				? await resolveAssistantToolPrincipal(services.db.admin, match[1], async (sessionId) => {
						const identity = await betterAuth?.getIdentityBySessionId(sessionId);
						return identity ? resolveBrowserPrincipal(services, identity) : null;
					})
				: null;
			if (!principal)
				return jsonResponse(401, {
					jsonrpc: "2.0",
					id: (ctx.body as { id?: unknown } | null)?.id ?? null,
					error: { code: -32_000, message: "Unauthorized" },
				});
			return jsonResponse(
				200,
				await Effect.runPromise(handleAssistantMcp(assistantToolServices, principal, ctx.body)),
			);
		},
	});
	route({
		method: "POST",
		pattern: "/api/v1/render",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const parsed = safeDecode(renderRequestSchema, ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_render_request",
						message: "invalid render request",
						retryable: false,
					},
				});
			const record = await Effect.runPromise(
				readQueryRecord(services.db.app, p.scopes, parsed.data.query_ref),
			);
			if (!record)
				return jsonResponse(404, {
					error: { code: "query_not_found", message: "query ref not found", retryable: false },
				});
			const result = await Effect.runPromise(
				runStructured(services.db.app, p.scopes, record.request),
			);
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
			const parsed = safeDecode(dashboardSaveSchema, ctx.body);
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
				return jsonResponse(
					200,
					await Effect.runPromise(saveDashboard(services.db, p, parsed.data)),
				);
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
			const parsed = safeDecode(investigationBranchSchema, ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: {
						code: "bad_investigation_branch",
						message: "invalid investigation branch",
						retryable: false,
					},
				});
			const input = parsed.data;
			const record = await Effect.runPromise(
				readQueryRecord(services.db.app, p.scopes, input.panel.query_ref),
			);
			if (!record)
				return jsonResponse(404, {
					error: {
						code: "query_not_found",
						message: "parent query ref not found",
						retryable: false,
					},
				});
			try {
				const filtered = await Effect.runPromise(
					runStructured(
						services.db.app,
						p.scopes,
						branchQuery(record.request, input.selected_mark.field, input.selected_mark.value),
					),
				);
				const dashboard = Schema.decodeUnknownSync(dashboardSaveSchema)({
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
				return jsonResponse(200, await Effect.runPromise(saveDashboard(services.db, p, dashboard)));
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
					await Effect.runPromise(
						listDashboards(services.db.app, p.scopes, services.cursorSecret, {
							...(query.limit ? { limit: Number(query.limit) } : {}),
							...(query.cursor ? { cursor: query.cursor } : {}),
						}),
					),
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
			const dashboard = await Effect.runPromise(
				loadDashboard(services.db.app, p.scopes, dashboardId),
			);
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
			const parsed = safeDecode(dashboardPinSchema, ctx.body);
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
				return jsonResponse(
					200,
					await Effect.runPromise(setHomeDashboard(services.db.writer, p, dashboardId)),
				);
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
			const item = await Effect.runPromise(readLibraryItem(services.db.app, p.scopes, itemId));
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
			const body = safeDecode(capabilityAcquireBodySchema, ctx.body ?? {});
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
					await Effect.runPromise(
						acquireCapability(services.db.app, principal.scopes, capability, body.data.provider),
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
			return jsonResponse(
				200,
				await Effect.runPromise(searchPalette(services, principal, text, limit)),
			);
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
			return jsonResponse(
				200,
				await Effect.runPromise(readAvailability(services.db.app, principal.scopes, windowS)),
			);
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
				await Effect.runPromise(
					readCommsLog(services.db.app, principal.scopes, {
						...(query.type ? { type: query.type as CommsType } : {}),
						...(query.agent ? { agent: query.agent } : {}),
						...(taskId !== undefined ? { taskId } : {}),
						...(limit !== undefined ? { limit } : {}),
						...(query.cursor ? { cursor: query.cursor } : {}),
					}),
				),
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
				await Effect.runPromise(readSignalSourceModes(services.db.app, principal.scopes, opts)),
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
						await Effect.runPromise(
							readEntity(services.db.app, principal.scopes, entityRoute.kind, opts),
						),
					);
				const result =
					entityRoute.kind === "delivery_config"
						? readDeliveryConfig(services.db.app, principal.scopes, opts)
						: readTypedEntity(services.db.app, principal.scopes, entityRoute.kind, opts);
				const envelope = await Effect.runPromise(result);
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
			const raw = await Effect.runPromise(
				readBoxUpdateRaw(services.db.app, principal.scopes, boxId),
			);
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
			const registry = await Effect.runPromise(
				readEntity(services.db.app, principal.scopes, "edge", {
					limit: 1_000,
					requiredFields: ["pubkey_fp", "state"],
				}),
			);
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
				(query.cursor && !UUID_RE.test(query.cursor)) ||
				(query.since && Number.isNaN(Date.parse(query.since)))
			)
				return jsonResponse(400, {
					error: {
						code: "bad_pagination",
						message: "limit, cursor, or since is invalid",
						retryable: false,
					},
				});
			return jsonResponse(
				200,
				await Effect.runPromise(
					readUpdateApprovals(services.db.app, principal.scopes, boxId, {
						limit: requestedLimit,
						...(query.cursor ? { cursor: query.cursor } : {}),
						...(query.since ? { since: query.since } : {}),
					}),
				),
			);
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
			return jsonResponse(
				200,
				Effect.runSync(readTasks(services.tracker as TrackerReader, ctx.principal.scopes)),
			);
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
				Effect.runSync(readWorkSettlement(services.tracker as TrackerReader, ctx.principal.scopes)),
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
			return jsonResponse(
				200,
				Effect.runSync(readLeases(services.tracker as TrackerReader, ctx.principal.scopes)),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/agents",
		auth: true,
		handler: (ctx) => {
			const unavailable = trackerUnavailable();
			if (unavailable) return unavailable;
			return jsonResponse(
				200,
				Effect.runSync(readAgents(services.tracker as TrackerReader, ctx.principal.scopes)),
			);
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/roster",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			const roster = await Effect.runPromise(
				readRoster(services.db.app, services.tracker, p.scopes),
			);
			return jsonResponse(200, {
				...roster,
				items: roster.items.map((item) => flattenRosterItem(item)),
			});
		},
	});
	route({
		method: "GET",
		pattern: "/api/v1/executors",
		auth: true,
		handler: async (ctx) => {
			const p = ctx.principal;
			return jsonResponse(200, await Effect.runPromise(readExecutors(services.db.app, p.scopes)));
		},
	});

	// --- terminal gate + frame transport --------------------------------------------------------
	route({
		method: "GET",
		pattern: "/api/v1/terminal",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			try {
				return jsonResponse(200, await Effect.runPromise(terminalDomain.access(ctx.principal)));
			} catch (error) {
				return terminalFailure(error);
			}
		},
	});

	route({
		method: "POST",
		pattern: "/api/v1/terminal/peek",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const parsed = safeDecode(terminalTargetSchema, ctx.body);
			if (!parsed.success)
				return jsonResponse(400, {
					error: { code: "invalid_target", message: "invalid terminal target", retryable: false },
				});
			const target: TerminalTarget = {
				host: parsed.data.host,
				tmuxSession: parsed.data.tmux_session,
				paneId: parsed.data.pane_id,
			};
			try {
				return jsonResponse(
					200,
					await Effect.runPromise(
						terminalDomain.openPeek(ctx.principal, target, parsed.data.scrollback_lines),
					),
				);
			} catch (error) {
				return terminalFailure(error);
			}
		},
	});

	route({
		method: "GET",
		pattern: "/api/v1/terminal/peek/:streamId",
		auth: true,
		rateLimit: true,
		handler: async (ctx) => {
			const streamId = (ctx.params as { streamId: string }).streamId;
			try {
				return jsonResponse(
					200,
					await Effect.runPromise(terminalDomain.pollPeek(ctx.principal, streamId)),
				);
			} catch (error) {
				return terminalFailure(error);
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
			const parsed = safeDecode(terminalTargetSchema, ctx.body);
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
			const session = terminalDomain.create(principal, target, streamId, true);
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
			const parsed = safeDecode(terminalInputSchema, ctx.body);
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
			// Strict-preflight parity with the legacy CORS layer: an OPTIONS request carrying both Origin and
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
		// Fired post-response like the legacy onResponse hook: the caller never waits on telemetry.
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
		browserOrigin: browserOrigin ?? null,
		busCounters,
		routes: routes.map((def) => ({ method: def.method, pattern: def.pattern })),
		close() {
			terminalDomain.closeAll();
		},
	};
}
