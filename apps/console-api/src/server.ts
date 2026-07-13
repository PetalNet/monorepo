// The HTTP + WS surface (contract §1.1). Fastify with a bearer/dev auth hook that resolves a
// server-stamped Principal, then the four-plane routes. N1a ships Query + Bus + emit + health/me;
// the Command and Library planes land in N1c/N1d.

import { timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { buildServices, type Services } from "./app.ts";
import { ask } from "./assistant/engine.ts";
import { AssistantRuntimeError } from "./assistant/runtime.ts";
import { handleAssistantMcp, resolveAssistantToolPrincipal } from "./assistant/tools.ts";
import {
	canViewGrantObject,
	GrantError,
	grantMutationSchema,
	listGrants,
	mutateGrant,
} from "./auth/grants.ts";
import { resolveBearer, resolveScopes, devPrincipal, type Principal } from "./auth/principal.ts";
import { ProposalError, proposeMutation } from "./auth/proposals.ts";
import { type GrantRelation, listTiers, shouldProposeMutation } from "./auth/tiers.ts";
import type { SubscribeSpec } from "./bus/broker.ts";
import {
	DashboardError,
	dashboardTargetScope,
	listDashboards,
	loadDashboard,
	saveDashboard,
} from "./dashboard/store.ts";
import { withScopes } from "./db/pool.ts";
import { loadEnv } from "./env.ts";
import { scrubUnknown } from "./ingest/scrubber.ts";
import {
	initExceptionMonitor,
	inertExceptionMonitor,
	reportSelfEmissionFailure,
	sanitizedException,
	type ExceptionMonitor,
} from "./observability.ts";
import type { ProjectionKind } from "./projector/index.ts";
import { readQueryRecord } from "./query/history.ts";
import { runStructured, QueryError, type QueryRequest } from "./query/structured.ts";
import { readEntity } from "./reads/entities.ts";
import { readRoster, readExecutors } from "./reads/roster.ts";
import { readTasks, readLeases, readAgents } from "./reads/tracker-reads.ts";
import type { TrackerReader } from "./reads/tracker.ts";
import { materializePanel } from "./render/engine.ts";
import type { PanelSpecV2 } from "./render/types.ts";
import {
	dashboardSaveSchema,
	renderRequestSchema,
	selectedMarkSchema,
} from "./render/validation.ts";
import { mergeSemanticShape, type SemanticShape } from "./semantic/registry.ts";
import { searchSemanticCorpus } from "./semantic/search.ts";

declare module "fastify" {
	interface FastifyRequest {
		principal?: Principal;
	}
}

const askRequestSchema = z.object({ question: z.string().min(1).max(2_000) }).strict();
const assistantMessageSchema = z
	.object({ id: z.string().uuid(), message: z.string().min(1).max(100_000).regex(/\S/) })
	.strict();
const assistantContextSchema = z
	.object({
		id: z.string().uuid(),
		payload: selectedMarkSchema.extend({
			value: z.unknown().refine((value) => value !== undefined, "value is required"),
		}),
	})
	.strict();

export interface BrowserAuthConfig {
	readonly consoleOrigin: string;
	readonly proxyNonce: string;
	readonly trustedProxies: readonly string[];
}

const AUTHENTIK_HEADERS = new Set([
	"x-authentik-username",
	"x-authentik-groups",
	"x-authentik-email",
]);
const AUTH_PROXY_NONCE_HEADER = "x-console-auth-proxy-nonce";
const LANE_ORDER = ["viewer", "editor", "operator", "admin"] as const;

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || codePoint === 0x7f;
	});
}

function strictForwardAuthHeaders(
	req: FastifyRequest,
	expectedNonce: string,
): { username: string; groups: string[] } | null {
	const seen = new Map<string, string[]>();
	const raw = req.raw.rawHeaders;
	for (let index = 0; index < raw.length; index += 2) {
		const rawName = raw[index] ?? "";
		const value = raw[index + 1] ?? "";
		const name = rawName.trim().toLowerCase();
		if (rawName.includes("_") && rawName.toLowerCase().includes("authentik")) return null;
		if (name.startsWith("x-authentik-") && !AUTHENTIK_HEADERS.has(name)) return null;
		if (AUTHENTIK_HEADERS.has(name) || name === AUTH_PROXY_NONCE_HEADER) {
			if (hasControlCharacter(value)) return null;
			const values = seen.get(name) ?? [];
			values.push(value);
			seen.set(name, values);
		}
	}
	for (const values of seen.values()) if (values.length !== 1) return null;
	const nonce = seen.get(AUTH_PROXY_NONCE_HEADER)?.[0];
	if (!nonce || nonce.length !== expectedNonce.length) return null;
	if (!timingSafeEqual(Buffer.from(nonce), Buffer.from(expectedNonce))) return null;
	const username = seen.get("x-authentik-username")?.[0]?.trim() ?? "";
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) return null;
	const groups = (seen.get("x-authentik-groups")?.[0] ?? "")
		.split("|")
		.map((group) => group.trim())
		.filter(Boolean);
	if (groups.length === 0 || new Set(groups).size !== groups.length) return null;
	return { username, groups };
}

async function resolveForwardAuth(
	services: Services,
	req: FastifyRequest,
	config: BrowserAuthConfig,
): Promise<Principal | null> {
	const remoteAddress = req.raw.socket.remoteAddress;
	const normalizedRemote = remoteAddress?.startsWith("::ffff:")
		? remoteAddress.slice("::ffff:".length)
		: remoteAddress;
	if (!normalizedRemote || !config.trustedProxies.includes(normalizedRemote)) return null;
	const identity = strictForwardAuthHeaders(req, config.proxyNonce);
	if (!identity) return null;
	const rows = await services.db.admin<
		{ name: string; default_relations: string[] }[]
	>`select name, default_relations from tiers
	  where authentik_group = any(${services.db.admin.array(identity.groups)})
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
	const { scopes, zookie } = await resolveScopes(services.db.admin, identity.username, tiers);
	return { kind: "human", id: identity.username, tiers, lanes, scopes, zookie };
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

export async function buildServer(
	services: Services,
	devAuth: boolean,
	monitor: ExceptionMonitor = inertExceptionMonitor,
	browserAuth: BrowserAuthConfig | null = null,
) {
	if (browserAuth?.trustedProxies.length === 0)
		throw new Error("browser auth requires at least one trusted proxy");
	const app = Fastify({
		logger: false,
		bodyLimit: 1024 * 1024,
		...(browserAuth ? { trustProxy: [...browserAuth.trustedProxies] } : {}),
	});
	if (browserAuth) {
		app.addHook("onRequest", async (req, reply) => {
			const origin = req.headers.origin;
			if (origin && origin !== browserAuth.consoleOrigin)
				return reply.code(403).send({
					error: { code: "origin_denied", message: "origin is not allowed", retryable: false },
				});
		});
		await app.register(cors, {
			origin: browserAuth.consoleOrigin,
			credentials: true,
			methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowedHeaders: ["accept", "authorization", "content-type"],
			strictPreflight: true,
		});
	}
	await app.register(websocket);
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
	const requestStarted = new WeakMap<FastifyRequest, number>();
	app.addHook("onRequest", async (req) => {
		requestStarted.set(req, performance.now());
	});
	app.addHook("onResponse", async (req, reply) => {
		// Successful self-observation is sampled 1:10; every failed request is retained. Only bounded
		// metadata is captured — never Authorization, request bodies, term input, or response bodies.
		requestSample += 1;
		if (reply.statusCode < 400 && requestSample % 10 !== 0) return;
		const raw = {
			schema_version: 1 as const,
			id: crypto.randomUUID(),
			type: "console.api.request",
			ts: new Date().toISOString(),
			source: { service: "console-api", host: null, agent: null },
			subject: "console-api",
			subject_kind: "service" as const,
			severity: reply.statusCode >= 500 ? ("danger" as const) : ("info" as const),
			scope: "fleet",
			dimensions: {
				method: req.method,
				route: req.routeOptions.url,
				status: String(reply.statusCode),
			},
			measures: {
				duration_ms: Math.max(
					0,
					performance.now() - (requestStarted.get(req) ?? performance.now()),
				),
			},
		};
		await emitSelf(raw);
	});
	app.setErrorHandler(async (error, req, reply) => {
		monitor.captureException(sanitizedException(error));
		const raw = {
			schema_version: 1 as const,
			id: crypto.randomUUID(),
			type: "console.api.error",
			ts: new Date().toISOString(),
			source: { service: "console-api", host: null, agent: null },
			subject: "console-api",
			subject_kind: "service" as const,
			severity: "danger" as const,
			scope: "fleet",
			dimensions: {
				method: req.method,
				route: req.routeOptions.url,
				error_class: error instanceof Error ? error.constructor.name : "UnknownError",
			},
		};
		await emitSelf(raw);
		return reply.code(500).send({
			error: { code: "internal_error", message: "internal server error", retryable: true },
		});
	});

	async function auth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
		const authz = req.headers.authorization;
		if (authz?.startsWith("Bearer ")) {
			const p = await resolveBearer(services.db.admin, authz.slice(7));
			if (p) {
				req.principal = p;
				return;
			}
		}
		if (browserAuth) {
			const p = await resolveForwardAuth(services, req, browserAuth);
			if (p) {
				req.principal = p;
				return;
			}
		}
		if (devAuth) {
			const dev = req.headers["x-dev-principal"];
			if (typeof dev === "string") {
				const p = devPrincipal(dev);
				if (p) {
					req.principal = p;
					return;
				}
			}
		}
		await reply.code(401).send({
			error: { code: "unauthorized", message: "valid credentials required", retryable: false },
		});
	}

	async function maybePropose(
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

	function proposalFailure(reply: FastifyReply, error: ProposalError) {
		const status =
			error.code === "id_reused"
				? 409
				: error.code === "proposal_too_large"
					? 413
					: error.code === "secret_detected"
						? 400
						: 503;
		return reply.code(status).send({
			error: { code: error.code, message: error.message, retryable: error.retryable },
		});
	}

	// --- health (unauthenticated) --------------------------------------------------------------
	app.get("/api/v1/health", async () => {
		let lake: "ok" | "down" = "ok";
		try {
			await services.db.admin`select 1`;
		} catch {
			lake = "down";
		}
		return {
			lake,
			seq_head: services.broker.head,
			bridges: [],
			ws_clients: 0,
			matrix_sync_ok_epoch: null,
		};
	});

	// --- me --------------------------------------------------------------------------------------
	app.get("/api/v1/me", { preHandler: auth }, async (req) => {
		const p = req.principal as Principal;
		return {
			schema_version: 1,
			kind: p.kind,
			id: p.id,
			tiers: p.tiers,
			lanes: p.lanes,
			scopes: p.scopes,
			zookie: p.zookie,
		};
	});

	// --- extensible permission-level catalog ---------------------------------------------------
	app.get("/api/v1/tiers", { preHandler: auth }, async () => listTiers(services.db.app));

	// --- ReBAC grants ---------------------------------------------------------------------------
	app.get("/api/v1/grants", { preHandler: auth }, async (req, reply) => {
		const principal = req.principal as Principal;
		const object = (req.query as { object?: string }).object;
		if (!object)
			return reply.code(400).send({
				error: {
					code: "bad_object",
					message: "object query parameter is required",
					retryable: false,
				},
			});
		try {
			return await listGrants(services.db.writer, principal, object);
		} catch (error) {
			if (!(error instanceof GrantError)) throw error;
			return reply.code(error.code === "grant_denied" ? 403 : 400).send({
				error: { code: error.code, message: error.message, retryable: false },
			});
		}
	});

	app.post("/api/v1/grants", { preHandler: auth }, async (req, reply) => {
		const parsed = grantMutationSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: {
					code: "bad_grant",
					message: parsed.error.issues[0]?.message ?? "invalid grant",
					retryable: false,
				},
			});
		try {
			const principal = req.principal as Principal;
			if (!(await canViewGrantObject(services.db.admin, principal, parsed.data.object)))
				throw new GrantError("grant_denied", "object is not visible to the caller");
			const proposed = await maybePropose(
				principal,
				"grant.mutate",
				parsed.data.id,
				parsed.data,
				parsed.data.object,
				"owner",
			);
			if (proposed) return proposed;
			return await mutateGrant(services.db, req.principal as Principal, parsed.data);
		} catch (error) {
			if (error instanceof ProposalError) return proposalFailure(reply, error);
			if (!(error instanceof GrantError)) throw error;
			return reply
				.code(error.code === "grant_denied" ? 403 : error.code === "bad_grant" ? 400 : 409)
				.send({ error: { code: error.code, message: error.message, retryable: false } });
		}
	});

	// --- emit ------------------------------------------------------------------------------------
	app.post("/api/v1/emit", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const bytes = Buffer.byteLength(JSON.stringify(req.body ?? {}));
		const outcome = await services.emit(p, req.body, bytes);
		if (!outcome.ok) {
			const rateLimited =
				outcome.code === "emit_rate_limited" || outcome.code === "new_type_rate_limited";
			reply.code(outcome.code === "unregistered_producer" ? 403 : rateLimited ? 429 : 400);
			const retryAfterS = outcome.retryAfterS ?? (outcome.code === "emit_rate_limited" ? 60 : 3600);
			if (rateLimited) reply.header("retry-after", String(retryAfterS));
			return reply.send({
				error: {
					code: outcome.code,
					message: outcome.message,
					retryable: rateLimited,
					...(rateLimited ? { retry_after_s: retryAfterS } : {}),
				},
			});
		}
		return reply.code(202).send({ seq: outcome.seq, duplicate: outcome.duplicate ?? false });
	});

	app.post("/api/v1/emit/batch", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const body = req.body;
		if (!Array.isArray(body))
			return reply
				.code(400)
				.send({ error: { code: "invalid_batch", message: "expected array", retryable: false } });
		if (body.length > 500)
			return reply
				.code(400)
				.send({ error: { code: "batch_too_large", message: "max 500", retryable: false } });
		const results = [];
		for (const item of body) {
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
									outcome.code === "emit_rate_limited" || outcome.code === "new_type_rate_limited",
								...(outcome.retryAfterS ? { retry_after_s: outcome.retryAfterS } : {}),
							},
						},
			);
		}
		return reply.code(202).send({ results });
	});

	// --- query -----------------------------------------------------------------------------------
	app.post("/api/v1/query", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const body = req.body as QueryRequest;
		if (body?.mode === "sql") {
			if (!p.lanes.includes("operator") && !p.lanes.includes("admin"))
				return reply.code(403).send({
					error: {
						code: "lane_denied",
						message: "sql mode requires operator+",
						retryable: false,
					},
				});
			return reply.code(400).send({
				error: { code: "not_implemented", message: "sql mode lands in N1d", retryable: false },
			});
		}
		try {
			const result = await runStructured(services.db.app, p.scopes, body);
			return result;
		} catch (err) {
			if (err instanceof QueryError)
				return reply
					.code(400)
					.send({ error: { code: err.code, message: err.message, retryable: false } });
			throw err;
		}
	});
	app.get("/api/v1/query/:queryRef", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const { queryRef } = req.params as { queryRef: string };
		const record = await readQueryRecord(services.db.app, p.scopes, queryRef);
		if (!record)
			return reply.code(404).send({
				error: { code: "query_not_found", message: "query ref not found", retryable: false },
			});
		return { schema_version: 1, ...record };
	});
	app.post("/api/v1/query/:queryRef/rerun", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const { queryRef } = req.params as { queryRef: string };
		const record = await readQueryRecord(services.db.app, p.scopes, queryRef);
		if (!record)
			return reply.code(404).send({
				error: { code: "query_not_found", message: "query ref not found", retryable: false },
			});
		try {
			return await runStructured(services.db.app, p.scopes, record.request);
		} catch (err) {
			if (err instanceof QueryError)
				return reply
					.code(400)
					.send({ error: { code: err.code, message: err.message, retryable: false } });
			throw err;
		}
	});
	app.post("/api/v1/ask", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const parsed = askRequestSchema.safeParse(req.body);
		if (!parsed.success || !parsed.data.question.trim())
			return reply.code(400).send({
				error: {
					code: "bad_question",
					message: "question is required (max 2000 chars)",
					retryable: false,
				},
			});
		if (!services.assistant)
			return reply.code(503).send({
				error: {
					code: "assistant_unavailable",
					message: "dashboard assistant compiler is not configured",
					retryable: true,
				},
			});
		return ask(services.db, services.assistant, p.scopes, parsed.data.question.trim());
	});
	function runtimeFailure(reply: FastifyReply, error: AssistantRuntimeError) {
		const status = error.code === "id_reused" ? 409 : error.code === "secret_detected" ? 400 : 503;
		return reply.code(status).send({
			error: { code: error.code, message: error.message, retryable: error.retryable },
		});
	}
	app.get("/api/v1/assistant/session", { preHandler: auth }, async (req) => {
		const p = req.principal as Principal;
		const rows = await services.db.writer<
			{
				manager_session_id: string | null;
				state: string;
				window_layout: unknown;
				last_context: unknown;
			}[]
		>`select manager_session_id, state, window_layout, last_context from assistant_sessions
		  where principal_id = ${p.id}`;
		return {
			schema_version: 1,
			session: rows[0]
				? {
						session_id: rows[0].manager_session_id,
						state: rows[0].state,
						window_layout: rows[0].window_layout,
						last_context: rows[0].last_context,
					}
				: null,
		};
	});
	app.post("/api/v1/assistant/messages", { preHandler: auth }, async (req, reply) => {
		const parsed = assistantMessageSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: { code: "bad_message", message: "invalid assistant message", retryable: false },
			});
		if (!services.assistantRuntime)
			return reply.code(503).send({
				error: {
					code: "assistant_runtime_unavailable",
					message: "per-user assistant runtime is not configured",
					retryable: true,
				},
			});
		try {
			return await services.assistantRuntime.send(req.principal as Principal, {
				id: parsed.data.id,
				kind: "user",
				content: parsed.data.message,
			});
		} catch (error) {
			if (error instanceof AssistantRuntimeError) return runtimeFailure(reply, error);
			throw error;
		}
	});
	app.post("/api/v1/assistant/context", { preHandler: auth }, async (req, reply) => {
		const parsed = assistantContextSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: { code: "bad_context", message: "invalid selected context", retryable: false },
			});
		if (!scrubUnknown(parsed.data.payload, "context.payload").ok)
			return reply.code(400).send({
				error: { code: "secret_detected", message: "context contains a secret", retryable: false },
			});
		if (!services.assistantRuntime)
			return reply.code(503).send({
				error: {
					code: "assistant_runtime_unavailable",
					message: "per-user assistant runtime is not configured",
					retryable: true,
				},
			});
		try {
			return await services.assistantRuntime.send(req.principal as Principal, {
				id: parsed.data.id,
				kind: "context",
				content: JSON.stringify(parsed.data.payload),
			});
		} catch (error) {
			if (error instanceof AssistantRuntimeError) return runtimeFailure(reply, error);
			throw error;
		}
	});
	app.post("/api/v1/assistant/mcp", async (req, reply) => {
		const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
		const principal = match?.[1]
			? await resolveAssistantToolPrincipal(services.db.admin, match[1])
			: null;
		if (!principal)
			return reply.code(401).send({
				jsonrpc: "2.0",
				id: (req.body as { id?: unknown } | null)?.id ?? null,
				error: { code: -32_000, message: "Unauthorized" },
			});
		return handleAssistantMcp(services, principal, req.body);
	});
	app.post("/api/v1/render", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const parsed = renderRequestSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: { code: "bad_render_request", message: "invalid render request", retryable: false },
			});
		const record = await readQueryRecord(services.db.app, p.scopes, parsed.data.query_ref);
		if (!record)
			return reply.code(404).send({
				error: { code: "query_not_found", message: "query ref not found", retryable: false },
			});
		const result = await runStructured(services.db.app, p.scopes, record.request);
		return materializePanel(parsed.data.panel as PanelSpecV2, result);
	});

	// --- renderer-agnostic saved dashboards / investigation branches ---------------------------
	app.post("/api/v1/dashboards", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const parsed = dashboardSaveSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: { code: "bad_dashboard", message: "invalid dashboard payload", retryable: false },
			});
		try {
			const targetScope = dashboardTargetScope(p, parsed.data.scope);
			if (!targetScope || !p.scopes.includes(targetScope))
				throw new DashboardError("scope_denied", "dashboard scope is not visible to the caller");
			const proposed = await maybePropose(
				p,
				"dashboard.save",
				parsed.data.id,
				parsed.data,
				targetScope,
				"editor",
			);
			if (proposed) return proposed;
			return await saveDashboard(services.db, p, parsed.data);
		} catch (error) {
			if (error instanceof ProposalError) return proposalFailure(reply, error);
			if (error instanceof DashboardError)
				return reply
					.code(error.code === "scope_denied" ? 403 : 400)
					.send({ error: { code: error.code, message: error.message, retryable: false } });
			throw error;
		}
	});
	app.get("/api/v1/dashboards", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { limit?: string; cursor?: string };
		try {
			return await listDashboards(services.db.app, p.scopes, services.cursorSecret, {
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
			});
		} catch (error) {
			if (error instanceof DashboardError)
				return reply
					.code(400)
					.send({ error: { code: error.code, message: error.message, retryable: false } });
			throw error;
		}
	});
	app.get("/api/v1/dashboards/:dashboardId", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const { dashboardId } = req.params as { dashboardId: string };
		if (!/^dash_[A-Za-z0-9_-]{8,40}$/.test(dashboardId))
			return reply.code(404).send({
				error: { code: "dashboard_not_found", message: "dashboard not found", retryable: false },
			});
		const dashboard = await loadDashboard(services.db.app, p.scopes, dashboardId);
		if (!dashboard)
			return reply.code(404).send({
				error: { code: "dashboard_not_found", message: "dashboard not found", retryable: false },
			});
		return dashboard;
	});

	// --- catalog ---------------------------------------------------------------------------------
	app.get("/api/v1/catalog", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		if (p.scopes.length === 0)
			return {
				schema_version: 1,
				freshness: {
					source: "semantic-registry",
					observed_at: new Date().toISOString(),
					window_s: null,
				},
				items: [],
				next_cursor: null,
				truncated: false,
			};
		const query = req.query as {
			type?: string;
			scope?: string;
			limit?: string;
			cursor?: string;
			since?: string;
		};
		if (query.type && !/^[a-z0-9_.*]+$/.test(query.type))
			return reply.code(400).send({
				error: { code: "bad_catalog_filter", message: "invalid type glob", retryable: false },
			});
		if (query.since && !Number.isFinite(Date.parse(query.since)))
			return reply.code(400).send({
				error: { code: "bad_catalog_filter", message: "invalid since timestamp", retryable: false },
			});
		const cursor = parseCatalogCursor(query.cursor);
		if (query.cursor && !cursor)
			return reply.code(400).send({
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
		const rateByType = new Map(page.rates.map((row) => [row.type, Number(row.rate)]));
		const items = page.types.slice(0, limit).map(({ type }) => {
			const rows = page.rows.filter((row) => row.type === type);
			let shape: SemanticShape = { dimensions: {}, measures: {}, joins: [] };
			for (const row of rows) shape = mergeSemanticShape(shape, row).shape;
			return {
				type,
				first_seen: rows.map((row) => row.first_seen).sort()[0],
				last_emit:
					rows
						.map((row) => row.last_emit)
						.filter((value): value is string => value !== null)
						.sort()
						.at(-1) ?? null,
				dimensions: shape.dimensions,
				measures: shape.measures,
				joins: shape.joins,
				scopes: rows.map((row) => row.scope).sort(),
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
				.sort()
				.at(-1) ?? new Date().toISOString();
		return {
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
		};
	});
	app.get("/api/v1/catalog/search", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { q?: string; limit?: string };
		if (!query.q || query.q.length > 512)
			return reply.code(400).send({
				error: { code: "bad_search", message: "q is required (max 512 chars)", retryable: false },
			});
		const items = await searchSemanticCorpus(
			services.db.app,
			p.scopes,
			query.q,
			Number(query.limit ?? 8),
		);
		return { schema_version: 1, items };
	});

	// --- typed entity reads (current_state projection, N1b) --------------------------------------
	const ENTITY_ROUTES: Record<string, ProjectionKind> = {
		fleet: "fleet",
		heartbeats: "heartbeat",
		registry: "registry",
		governance: "governance",
		cards: "card",
		"box-updates": "box_update",
		workers: "worker",
		"edge/registry": "edge",
	};
	for (const [path, kind] of Object.entries(ENTITY_ROUTES)) {
		app.get(`/api/v1/${path}`, { preHandler: auth }, async (req) => {
			const p = req.principal as Principal;
			const q = req.query as { limit?: string; cursor?: string };
			return readEntity(services.db.app, p.scopes, kind, {
				limit: q.limit ? Number(q.limit) : undefined,
				cursor: q.cursor,
			});
		});
	}

	// --- tracker-sourced reads (single-writer store, mapped to console scope, N1b-2) -------------
	function trackerOr503(reply: FastifyReply): boolean {
		if (services.tracker) return true;
		void reply.code(503).send({
			error: {
				code: "tracker_unavailable",
				message: "TRACKER_DB_PATH not configured",
				retryable: true,
			},
		});
		return false;
	}
	app.get("/api/v1/tasks", { preHandler: auth }, async (req, reply) => {
		if (!trackerOr503(reply)) return reply;
		return readTasks(services.tracker as TrackerReader, (req.principal as Principal).scopes);
	});
	app.get("/api/v1/leases", { preHandler: auth }, async (req, reply) => {
		if (!trackerOr503(reply)) return reply;
		return readLeases(services.tracker as TrackerReader, (req.principal as Principal).scopes);
	});
	app.get("/api/v1/agents", { preHandler: auth }, async (req, reply) => {
		if (!trackerOr503(reply)) return reply;
		return readAgents(services.tracker as TrackerReader, (req.principal as Principal).scopes);
	});
	app.get("/api/v1/roster", { preHandler: auth }, async (req) => {
		const p = req.principal as Principal;
		return readRoster(services.db.app, services.tracker, p.scopes);
	});
	app.get("/api/v1/executors", { preHandler: auth }, async (req) => {
		const p = req.principal as Principal;
		return readExecutors(services.db.app, p.scopes);
	});

	// --- bus WS ----------------------------------------------------------------------------------
	app.get("/api/v1/bus/ws", { websocket: true }, (socket, req) => {
		let principal: Principal | null = null;
		const authz = req.headers.authorization;
		const connSubs: string[] = [];
		const send = (frame: Record<string, unknown>): void => {
			if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
		};
		const bearer = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
		const ready = (async () => {
			try {
				if (bearer) principal = await resolveBearer(services.db.admin, bearer);
				else if (devAuth && typeof req.headers["x-dev-principal"] === "string")
					principal = devPrincipal(req.headers["x-dev-principal"]);
			} catch {
				principal = null;
			}
			if (!principal) {
				send({
					schema_version: 1,
					kind: "ack",
					sub_id: "*",
					replay_through_seq: 0,
					error: { code: "unauthorized", message: "bearer required", retryable: false },
				});
				socket.close();
			}
		})();

		// LISTEN/NOTIFY makes grant changes re-fence immediately. The 30s check remains as a recovery
		// path for token revocation and a notification connection blip.
		let refreshing = false;
		let refreshAgain = false;
		const refreshPrincipal = async (): Promise<void> => {
			if (!bearer) return;
			if (refreshing) {
				refreshAgain = true;
				return;
			}
			refreshing = true;
			try {
				const fresh = await resolveBearer(services.db.admin, bearer);
				if (!fresh) {
					for (const id of connSubs) services.broker.unsubscribe(id);
					socket.close();
					return;
				}
				principal = fresh;
				services.broker.revalidateScopes(connSubs, fresh.scopes);
			} catch {
				/* transient DB blip: keep the connection, retry on the fallback timer */
			} finally {
				refreshing = false;
				if (refreshAgain && socket.readyState === socket.OPEN) {
					refreshAgain = false;
					void refreshPrincipal();
				}
			}
		};
		const stopGrantWatch = bearer
			? services.onGrantChange(() => {
					principal = null;
					services.broker.revalidateScopes(connSubs, []);
					void refreshPrincipal();
				})
			: null;
		const revalidateTimer = bearer
			? setInterval(() => {
					void refreshPrincipal();
				}, 30000)
			: null;
		if (revalidateTimer) revalidateTimer.unref();

		socket.on("message", (data: Buffer) => {
			void (async () => {
				await ready;
				if (!principal) return;
				let msg: {
					action?: string;
					sub_id?: string;
					pattern?: string;
					filter?: SubscribeSpec["filter"];
					since?: number;
				};
				try {
					msg = JSON.parse(data.toString()) as typeof msg;
				} catch {
					send({
						schema_version: 1,
						kind: "ack",
						sub_id: "?",
						replay_through_seq: services.broker.head,
						error: { code: "bad_frame", message: "invalid json", retryable: false },
					});
					return;
				}
				if (msg.action === "subscribe" && msg.sub_id && msg.pattern) {
					const spec: SubscribeSpec = {
						subId: msg.sub_id,
						pattern: msg.pattern,
						filter: msg.filter,
						since: msg.since,
						scopes: principal.scopes,
					};
					connSubs.push(msg.sub_id);
					await services.broker.subscribe(spec, send);
				} else if (msg.action === "unsubscribe" && msg.sub_id) {
					services.broker.unsubscribe(msg.sub_id);
				}
			})();
		});
		socket.on("close", () => {
			if (revalidateTimer) clearInterval(revalidateTimer);
			stopGrantWatch?.();
			for (const id of connSubs) services.broker.unsubscribe(id);
		});
	});

	return app;
}

// entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
	const env = loadEnv();
	const monitor = initExceptionMonitor(env.glitchtipDsn);
	const services = await buildServices(env);
	const server = await buildServer(services, env.devAuth, monitor, env.browserAuth);
	await server.listen({ host: env.host, port: env.port });
	process.stdout.write(`console-api listening on ${env.host}:${String(env.port)}\n`);
}
