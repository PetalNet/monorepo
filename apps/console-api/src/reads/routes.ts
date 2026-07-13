import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Principal } from "../auth/principal.ts";
import { readAvailability } from "../availability/service.ts";
import type { Sql } from "../db/pool.ts";
import type { ProjectionKind } from "../projector/index.ts";
import { decodeCommsCursor, readCommsLog, type CommsType } from "./comms.ts";
import {
	readBoxUpdateRaw,
	readDeliveryConfig,
	readEntity,
	readSignalSourceModes,
	type ReadOpts,
	readTypedEntity,
} from "./entities.ts";

type AuthHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface ReadRouteServices {
	app: Sql;
	auth: AuthHandler;
}

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

function readOpts(request: FastifyRequest, route: EntityRoute): ReadOpts | null {
	const query = request.query as { limit?: string; cursor?: string };
	const raw = request.query as Record<string, string | undefined>;
	if (raw["since"] && Number.isNaN(Date.parse(raw["since"]))) return null;
	const filters = new Set(route.filters ?? []);
	return {
		...(query.limit ? { limit: Number(query.limit) } : {}),
		...(query.cursor ? { cursor: query.cursor } : {}),
		...(raw["since"] ? { since: raw["since"] } : {}),
		...(filters.has("state") && raw["state"] ? { state: raw["state"] } : {}),
		...(filters.has("handle") && raw["handle"] ? { handle: raw["handle"] } : {}),
		...(filters.has("owner") && raw["owner"] ? { owner: raw["owner"] } : {}),
		...(route.requiredFields ? { requiredFields: route.requiredFields } : {}),
	};
}

/** Register each contracted entity read independently from the command/bus server surface. */
export function registerEntityReadRoutes(
	server: FastifyInstance,
	services: ReadRouteServices,
): void {
	server.get("/api/v1/availability", { preHandler: services.auth }, async (request, reply) => {
		const principal = request.principal as Principal;
		const requested = (request.query as { window?: string }).window ?? "30d";
		const windows: Readonly<Record<string, number>> = {
			"24h": 86_400,
			"7d": 7 * 86_400,
			"30d": 30 * 86_400,
		};
		const windowS = windows[requested];
		if (!windowS)
			return reply.code(400).send({
				error: {
					code: "bad_window",
					message: "window must be one of 24h, 7d, or 30d",
					retryable: false,
				},
			});
		return readAvailability(services.app, principal.scopes, windowS);
	});
	server.get("/api/v1/comms", { preHandler: services.auth }, async (request, reply) => {
		const principal = request.principal as Principal;
		const query = request.query as {
			type?: string;
			agent?: string;
			task_id?: string;
			limit?: string;
			cursor?: string;
		};
		const types = new Set<CommsType>(["task-card", "rpc", "mail"]);
		if (query.type && !types.has(query.type as CommsType))
			return reply.code(400).send({
				error: {
					code: "bad_comms_type",
					message: "type must be task-card, rpc, or mail",
					retryable: false,
				},
			});
		if (query.agent && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(query.agent))
			return reply.code(400).send({
				error: {
					code: "bad_comms_agent",
					message: "agent must be a resident or service handle",
					retryable: false,
				},
			});
		const taskId = query.task_id === undefined ? undefined : Number(query.task_id);
		if (taskId !== undefined && (!Number.isSafeInteger(taskId) || taskId <= 0))
			return reply.code(400).send({
				error: {
					code: "bad_comms_task",
					message: "task_id must be a positive integer",
					retryable: false,
				},
			});
		if (query.cursor !== undefined && decodeCommsCursor(query.cursor) === null)
			return reply.code(400).send({
				error: {
					code: "bad_comms_cursor",
					message: "cursor is invalid",
					retryable: false,
				},
			});
		const limit = query.limit === undefined ? undefined : Number(query.limit);
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
			return reply.code(400).send({
				error: {
					code: "bad_comms_limit",
					message: "limit must be a positive integer",
					retryable: false,
				},
			});
		return readCommsLog(services.app, principal.scopes, {
			...(query.type ? { type: query.type as CommsType } : {}),
			...(query.agent ? { agent: query.agent } : {}),
			...(taskId !== undefined ? { taskId } : {}),
			...(limit !== undefined ? { limit } : {}),
			...(query.cursor ? { cursor: query.cursor } : {}),
		});
	});
	server.get("/api/v1/signal-sources", { preHandler: services.auth }, async (request, reply) => {
		const principal = request.principal as Principal;
		const opts = readOpts(request, { path: "signal-sources", kind: "fleet" });
		if (!opts)
			return reply.code(400).send({
				error: {
					code: "bad_since",
					message: "since must be an RFC 3339 timestamp",
					retryable: false,
				},
			});
		return readSignalSourceModes(services.app, principal.scopes, opts);
	});
	for (const route of ENTITY_ROUTES) {
		server.get(`/api/v1/${route.path}`, { preHandler: services.auth }, async (request, reply) => {
			const principal = request.principal as Principal;
			const opts = readOpts(request, route);
			if (!opts)
				return reply.code(400).send({
					error: {
						code: "bad_since",
						message: "since must be an RFC 3339 timestamp",
						retryable: false,
					},
				});
			if (!route.typed) return readEntity(services.app, principal.scopes, route.kind, opts);
			const result =
				route.kind === "delivery_config"
					? readDeliveryConfig(services.app, principal.scopes, opts)
					: readTypedEntity(services.app, principal.scopes, route.kind, opts);
			const envelope = await result;
			if (route.kind !== "attention") return envelope;
			return {
				...envelope,
				items: envelope.items.filter(
					(item) => typeof item["lane"] !== "string" || principal.lanes.includes(item["lane"]),
				),
			};
		});
	}
	server.get(
		"/api/v1/box-updates/:boxId/raw",
		{ preHandler: services.auth },
		async (request, reply) => {
			const principal = request.principal as Principal;
			const { boxId } = request.params as { boxId: string };
			const raw = await readBoxUpdateRaw(services.app, principal.scopes, boxId);
			if (raw) return raw;
			return reply.code(404).send({
				error: {
					code: "box_update_raw_not_found",
					message: "update detail is not available",
					retryable: false,
				},
			});
		},
	);
}
