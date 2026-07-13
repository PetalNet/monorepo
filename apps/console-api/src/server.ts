// The HTTP + WS surface (contract §1.1). Fastify with a bearer/dev auth hook that resolves a
// server-stamped Principal, then the four-plane routes. Query, Command, Bus, and the current
// Library seam are all served here; unavailable executor adapters fail closed.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

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
import { uuidv5 } from "./bridge/uuid5.ts";
import type { SubscribeSpec } from "./bus/broker.ts";
import { TrackerCommandError } from "./commands/tracker.ts";
import { costComparisonRequestSchema } from "./cost/compare.ts";
import { compareCostPair, CostComparisonUnavailableError } from "./cost/service.ts";
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
} from "./dashboard/store.ts";
import { withScopes } from "./db/pool.ts";
import { loadEnv } from "./env.ts";
import { scrubUnknown } from "./ingest/scrubber.ts";
import { KeyCeremonyError } from "./network/key-ceremony.ts";
import { MatrixDeliveryError } from "./notifications/matrix.ts";
import {
	initExceptionMonitor,
	inertExceptionMonitor,
	reportSelfEmissionFailure,
	sanitizedException,
	type ExceptionMonitor,
} from "./observability.ts";
import { rankPaletteCandidates, type PaletteCandidate } from "./palette/search.ts";
import { branchQuery } from "./query/branch.ts";
import { readQueryRecord } from "./query/history.ts";
import { runStructured, QueryError, type QueryRequest } from "./query/structured.ts";
import { readEntity, searchEntity } from "./reads/entities.ts";
import { readRoster, readExecutors } from "./reads/roster.ts";
import { registerEntityReadRoutes } from "./reads/routes.ts";
import { readTasks, readLeases, readAgents } from "./reads/tracker-reads.ts";
import type { TrackerReader } from "./reads/tracker.ts";
import { readWorkSettlement } from "./reads/work-settlement.ts";
import { acquireCapability, CapabilityAcquisitionError } from "./registry/acquisition.ts";
import {
	CapabilityContributionError,
	proposeCapability,
	reviewCapability,
} from "./registry/contribution.ts";
import { materializePanel } from "./render/engine.ts";
import type { PanelSpecV2 } from "./render/types.ts";
import {
	dashboardSaveSchema,
	investigationBranchSchema,
	renderRequestSchema,
	selectedMarkSchema,
} from "./render/validation.ts";
import { mergeSemanticShape, type SemanticShape } from "./semantic/registry.ts";
import { searchSemanticCorpus } from "./semantic/search.ts";

type JsonSchema = Record<string, unknown>;
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

const runFile = promisify(execFile);

/** Production PTY seam: bounded, non-interactive ssh calls with every remote token validated. */
export class SshTmuxTerminalAdapter implements TerminalAdapter {
	private sshArgs(host: string): string[] {
		return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host];
	}

	private async assertTarget(target: TerminalTarget): Promise<void> {
		const { stdout } = await runFile(
			"ssh",
			[
				...this.sshArgs(target.host),
				"tmux",
				"display-message",
				"-p",
				"-t",
				target.paneId,
				"\\#{session_name}",
			],
			{ encoding: "utf8", maxBuffer: 4_096, timeout: 10_000 },
		);
		if (stdout.trim() !== target.tmuxSession) throw new Error("PTY target session mismatch");
	}

	async health(): Promise<boolean> {
		try {
			await runFile("ssh", ["-V"], { timeout: 2_000 });
			return true;
		} catch {
			return false;
		}
	}

	async capture(target: TerminalTarget, scrollbackLines: number): Promise<Buffer> {
		await this.assertTarget(target);
		const { stdout } = await runFile(
			"ssh",
			[
				...this.sshArgs(target.host),
				"tmux",
				"capture-pane",
				"-p",
				"-e",
				"-S",
				`-${String(scrollbackLines)}`,
				"-t",
				target.paneId,
			],
			{ encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
		);
		return stdout;
	}

	async input(target: TerminalTarget, data: Buffer): Promise<void> {
		await this.assertTarget(target);
		await new Promise<void>((resolve, reject) => {
			const child = spawn("ssh", [
				...this.sshArgs(target.host),
				"tmux",
				"load-buffer",
				"-b",
				"console-input",
				"-",
				";",
				"paste-buffer",
				"-b",
				"console-input",
				"-d",
				"-t",
				target.paneId,
			]);
			let stderr = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`ssh tmux input failed (${String(code)}): ${stderr}`));
			});
			child.stdin.end(data);
		});
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

const CONTRACTS_DIR = new URL("../docs/contracts/", import.meta.url);
const schemaCache = new Map<string, JsonSchema>();
function readSchema(url: URL): JsonSchema {
	const key = url.href;
	const cached = schemaCache.get(key);
	if (cached) return cached;
	const parsed = JSON.parse(readFileSync(url, "utf8")) as JsonSchema;
	schemaCache.set(key, parsed);
	return parsed;
}

const opCatalog = readSchema(new URL("ops.json", CONTRACTS_DIR)) as {
	schema_version: number;
	ops: OpEntry[];
};
const busFrameSchema = readSchema(new URL("schemas/bus-frame.schema.json", CONTRACTS_DIR));
const clientBusFrameSchema: JsonSchema = {
	oneOf: [{ $ref: "#/$defs/subscribe" }, { $ref: "#/$defs/unsubscribe" }],
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

function schemaAtPointer(schema: JsonSchema, fragment: string): JsonSchema | null {
	let value: unknown = schema;
	for (const raw of fragment.replace(/^#\/?/, "").split("/").filter(Boolean)) {
		const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		value = (value as Record<string, unknown>)[part];
	}
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : null;
}

function schemaType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value === "number" ? "number" : typeof value;
}

/** The catalog uses a deliberately small, deterministic draft-2020-12 subset. */
export function validateJsonSchema(
	value: unknown,
	schema: JsonSchema,
	path = "args",
	root: JsonSchema = schema,
	base = CONTRACTS_DIR,
): string | null {
	if (typeof schema["$ref"] === "string") {
		const ref = schema["$ref"];
		const [file, fragment = ""] = ref.split("#", 2);
		const targetBase = file ? new URL(file, base) : base;
		const targetRoot = file ? readSchema(targetBase) : root;
		const target = fragment ? schemaAtPointer(targetRoot, `#${fragment}`) : targetRoot;
		return target
			? validateJsonSchema(value, target, path, targetRoot, file ? new URL(".", targetBase) : base)
			: `${path}: unresolved schema reference`;
	}
	for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		const errors = branches.map((branch) =>
			branch && typeof branch === "object"
				? validateJsonSchema(value, branch as JsonSchema, path, root, base)
				: `${path}: invalid schema`,
		);
		if (keyword === "allOf") {
			const failure = errors.find(Boolean);
			if (failure) return failure;
		} else if (keyword === "anyOf" && errors.every(Boolean)) return errors[0] ?? `${path}: invalid`;
		else if (keyword === "oneOf" && errors.filter((error) => !error).length !== 1)
			return `${path}: must match exactly one allowed shape`;
	}
	if (schema["if"] && typeof schema["if"] === "object") {
		const conditionMatches = !validateJsonSchema(
			value,
			schema["if"] as JsonSchema,
			path,
			root,
			base,
		);
		const branch = conditionMatches ? schema["then"] : schema["else"];
		if (branch && typeof branch === "object") {
			const error = validateJsonSchema(value, branch as JsonSchema, path, root, base);
			if (error) return error;
		}
	}
	if (Object.hasOwn(schema, "const") && !Object.is(value, schema["const"]))
		return `${path}: must equal the required value`;
	if (Array.isArray(schema["enum"]) && !schema["enum"].some((item) => Object.is(item, value)))
		return `${path}: value is not allowed`;
	const allowed = Array.isArray(schema["type"])
		? schema["type"]
		: typeof schema["type"] === "string"
			? [schema["type"]]
			: [];
	const actual = schemaType(value);
	if (
		allowed.length &&
		!allowed.includes(actual) &&
		!(actual === "integer" && allowed.includes("number"))
	)
		return `${path}: expected ${allowed.join(" or ")}`;
	if (typeof value === "string") {
		if (typeof schema["minLength"] === "number" && value.length < schema["minLength"])
			return `${path}: string is too short`;
		if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"])
			return `${path}: string is too long`;
		if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"]).test(value))
			return `${path}: invalid format`;
		if (schema["format"] === "uuid" && !z.string().uuid().safeParse(value).success)
			return `${path}: invalid UUID`;
		if (
			schema["format"] === "date-time" &&
			!z.string().datetime({ offset: true }).safeParse(value).success
		)
			return `${path}: invalid date-time`;
	}
	if (typeof value === "number") {
		if (typeof schema["minimum"] === "number" && value < schema["minimum"])
			return `${path}: below minimum`;
		if (typeof schema["maximum"] === "number" && value > schema["maximum"])
			return `${path}: above maximum`;
	}
	if (Array.isArray(value)) {
		if (typeof schema["minItems"] === "number" && value.length < schema["minItems"])
			return `${path}: too few items`;
		if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"])
			return `${path}: too many items`;
		if (
			schema["uniqueItems"] === true &&
			new Set(value.map((item) => JSON.stringify(item))).size !== value.length
		)
			return `${path}: items must be unique`;
		if (schema["items"] && typeof schema["items"] === "object")
			for (let index = 0; index < value.length; index += 1) {
				const error = validateJsonSchema(
					value[index],
					schema["items"] as JsonSchema,
					`${path}.${String(index)}`,
					root,
					base,
				);
				if (error) return error;
			}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (
			typeof schema["maxProperties"] === "number" &&
			Object.keys(record).length > schema["maxProperties"]
		)
			return `${path}: too many fields`;
		const required = Array.isArray(schema["required"]) ? schema["required"] : [];
		for (const key of required)
			if (typeof key === "string" && !Object.hasOwn(record, key)) return `${path}.${key}: required`;
		const properties =
			schema["properties"] && typeof schema["properties"] === "object"
				? (schema["properties"] as Record<string, JsonSchema>)
				: {};
		for (const [key, item] of Object.entries(record)) {
			const propertySchema = properties[key];
			if (propertySchema) {
				const error = validateJsonSchema(item, propertySchema, `${path}.${key}`, root, base);
				if (error) return error;
			} else if (schema["additionalProperties"] === false) return `${path}.${key}: unknown field`;
		}
	}
	return null;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

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
const opCallSchema = z
	.object({
		schema_version: z.literal(1),
		id: z.string().uuid(),
		op: z.string().regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/),
		args: z.record(z.string(), z.unknown()),
		task_id: z.number().int().nullable().optional(),
		reason: z.string().max(2_000).nullable().optional(),
		dry_run: z.boolean().default(false),
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
	// TERM_ADMIN is deliberately non-hierarchical: admin alone never implies shell access. It is
	// granted by a dedicated Authentik group/tier and therefore cannot leak through lane ordering.
	if (identity.groups.includes("term_admin") || tiers.includes("term_admin"))
		(lanes as string[]).push("term_admin");
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
	terminal: TerminalAdapter = new SshTmuxTerminalAdapter(),
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
	let wsClients = 0;
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

	async function resolveRequestPrincipal(req: FastifyRequest): Promise<Principal | null> {
		const authz = req.headers.authorization;
		if (authz?.startsWith("Bearer ")) {
			const p = await resolveBearer(services.db.admin, authz.slice(7));
			if (p) return p;
		}
		if (browserAuth) {
			const p = await resolveForwardAuth(services, req, browserAuth);
			if (p) return p;
		}
		if (devAuth) {
			const dev = req.headers["x-dev-principal"];
			if (typeof dev === "string") {
				const p = devPrincipal(dev);
				if (p) return p;
			}
		}
		return null;
	}

	async function auth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
		const principal = await resolveRequestPrincipal(req);
		if (principal) {
			req.principal = principal;
			return;
		}
		await reply.code(401).send({
			error: { code: "unauthorized", message: "valid credentials required", retryable: false },
		});
	}

	const opRateBuckets = new Map<string, { tokens: number; updatedAt: number; lastSeen: number }>();
	let opRateChecks = 0;
	async function opRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
		const principal = req.principal;
		if (!principal || reply.sent) return;
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
				const oldest = [...opRateBuckets].sort(
					([, left], [, right]) => left.lastSeen - right.lastSeen,
				)[0]?.[0];
				if (oldest) opRateBuckets.delete(oldest);
			}
		}
		if (tokens < 1) {
			const retryAfterS = Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1_000));
			opRateBuckets.set(principal.id, { tokens, updatedAt: now, lastSeen: now });
			await reply
				.code(429)
				.header("retry-after", String(retryAfterS))
				.send({
					error: {
						code: "rate_limited",
						message: "command request rate exceeded",
						retryable: true,
						retry_after_s: retryAfterS,
					},
				});
			return;
		}
		opRateBuckets.set(principal.id, { tokens: tokens - 1, updatedAt: now, lastSeen: now });
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

	type OpCall = z.infer<typeof opCallSchema>;
	type OpTarget = Record<string, unknown> & { scope?: string; owner?: string | null };
	const relationRank: Record<GrantRelation, number> = {
		viewer: 0,
		editor: 1,
		operator: 2,
		owner: 3,
	};

	function opEnvelope(
		call: Pick<OpCall, "id">,
		body: Record<string, unknown>,
	): Record<string, unknown> {
		return { schema_version: 1, in_reply_to: call.id, ...body };
	}

	function opError(
		reply: FastifyReply,
		call: Pick<OpCall, "id">,
		status: number,
		code: string,
		message: string,
		retryable = false,
	) {
		return reply.code(status).send(
			opEnvelope(call, {
				ok: false,
				status: null,
				result: null,
				error: { code, message, retryable },
				audit_seq: null,
				executor: null,
				undo: null,
			}),
		);
	}

	async function loadOpTarget(
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
				if (proposals[0]) return { ...proposals[0], owner: proposals[0].proposed_by };
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
			const item = items[0];
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
			if (events[0]) return { ...events[0].meta, ...events[0].dimensions, scope: events[0].scope };
		}
		if (typeof args["pubkey_fp"] === "string") {
			const edges = await services.db.admin<
				{ subject: string; scope: string; state: Record<string, unknown> }[]
			>`select subject, scope, state from current_state
			  where kind = 'edge' and state->>'pubkey_fp' = ${args["pubkey_fp"]}
			  order by seq desc limit 1`;
			if (edges[0]) return { ...edges[0].state, subject: edges[0].subject, scope: edges[0].scope };
		}
		if (entry.op === "subscription.set" || entry.op === "subscription.remove") {
			const owner = typeof args["owner"] === "string" ? args["owner"] : null;
			return owner ? { owner, scope: `user:${owner}` } : null;
		}
		return null;
	}

	function pathValue(value: unknown, path: string): unknown {
		let current = value;
		for (const part of path.split(".")) {
			if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
			current = (current as Record<string, unknown>)[part];
		}
		return current;
	}

	function resolveScopeTemplate(
		template: string,
		args: Record<string, unknown>,
		target: OpTarget | null,
	): string | null {
		let unresolved = false;
		const resolved = template.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
			const value = expression.startsWith("target.")
				? pathValue(target, expression.slice(7))
				: expression.startsWith("item.")
					? pathValue(args["item"], expression.slice(5))
					: pathValue(args, expression);
			if (value === undefined || value === null || typeof value === "object") {
				unresolved = true;
				return "";
			}
			return String(value);
		});
		return unresolved ? null : resolved;
	}

	async function hasGrant(
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
	const terminalSessions = new Map<string, TerminalSession>();
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
		if (!(await hasGrant(principal, "fleet", "owner"))) return "owner relation required on fleet";
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
		req: FastifyRequest,
		reply: FastifyReply,
	): Promise<TerminalSession | null> {
		const principal = req.principal as Principal;
		const denial = await authorizeTerminal(principal);
		if (denial) {
			await emitTerminalAudit(principal, "denied", null, null, denial);
			reply.code(403).send({
				error: { code: "term_denied", message: denial, retryable: false },
			});
			return null;
		}
		const streamId = (req.params as { streamId?: string }).streamId ?? "";
		const session = terminalSessions.get(streamId);
		if (!session || session.closed || session.principalId !== principal.id) {
			await emitTerminalAudit(principal, "denied", null, streamId || null, "stream not owned");
			reply.code(404).send({
				error: { code: "stream_not_found", message: "terminal stream not found", retryable: false },
			});
			return null;
		}
		return session;
	}

	async function authorizeOp(
		entry: OpEntry,
		principal: Principal,
		args: Record<string, unknown>,
	): Promise<
		{ ok: true; object: string | null; target: OpTarget | null } | { ok: false; message: string }
	> {
		const target = await loadOpTarget(entry, args);
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
				object:
					target?.scope ?? (principal.kind === "agent" ? principal.id : `user:${principal.id}`),
				target,
			};
		if (rule === "own" || rule === "own_or_grant") {
			if (owner === principal.id) return { ok: true, object: target?.scope ?? null, target };
			if (rule === "own") return { ok: false, message: "target is not owned by the caller" };
		}
		const relation = entry.authz.relation;
		if (!relation) return { ok: false, message: "catalog grant rule is incomplete" };
		for (const template of entry.authz.scope_any ?? []) {
			const object = resolveScopeTemplate(template, args, target);
			if (object && (await hasGrant(principal, object, relation)))
				return { ok: true, object, target };
		}
		return { ok: false, message: `${relation} relation required on the target` };
	}

	async function executorEvidence(
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
		if (entry.executor !== "manager")
			return { kind: entry.executor, ref: null, liveness: "unknown" };
		const ref = String(args["handle"] ?? target?.["handle"] ?? "");
		if (!ref) return { kind: entry.executor, ref: null, liveness: "unknown" };
		const rows = await services.db.admin<{ observed_at: string | Date }[]>`
			select observed_at from current_state where kind = 'heartbeat' and subject = ${ref}`;
		if (!rows[0]) return { kind: entry.executor, ref, liveness: "unknown" };
		const age = (Date.now() - new Date(rows[0].observed_at).getTime()) / 1_000;
		return {
			kind: entry.executor,
			ref,
			liveness: age <= 90 ? "alive" : age <= 300 ? "suspect" : "down",
		};
	}

	async function recordedOutcome(id: string): Promise<Record<string, unknown> | null> {
		const outcomeId = uuidv5(`op-outcome:${id}`);
		const rows = await services.db.admin<{ meta: Record<string, unknown> }[]>`
			select meta from events where id = ${outcomeId} order by seq desc limit 1`;
		const result = rows[0]?.meta?.["op_result"];
		return result && typeof result === "object" && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: null;
	}

	async function auditIntent(
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
			if (rows[0]?.meta?.["call_hash"] === callHash)
				return { ok: true, seq: Number(rows[0].seq), duplicate: true };
		}
		return { ok: false, code: outcome.code ?? "audit_unavailable" };
	}

	async function auditOutcome(
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
				return (await services.keyCeremony.approve({
					requestId: call.id,
					pubkeyFp: String(call.args["pubkey_fp"]),
					handle: String(call.args["handle"]),
					principal: principal.id,
				})) as unknown as Record<string, unknown>;
			case "edge.enroll.deny":
				if (!services.keyCeremony)
					throw new KeyCeremonyError(
						"doorman_unconfigured",
						"Doorman key ceremony is not configured",
						true,
					);
				return (await services.keyCeremony.deny({
					requestId: call.id,
					pubkeyFp: String(call.args["pubkey_fp"]),
					reason: call.reason?.trim() ?? "",
					principal: principal.id,
				})) as unknown as Record<string, unknown>;
			case "edge.key.revoke":
				if (!services.keyCeremony)
					throw new KeyCeremonyError(
						"doorman_unconfigured",
						"Doorman key ceremony is not configured",
						true,
					);
				return (await services.keyCeremony.revoke({
					requestId: call.id,
					pubkeyFp: String(call.args["pubkey_fp"]),
					handle: String(call.args["confirm_name"]),
					reason: call.reason?.trim() ?? "",
					principal: principal.id,
				})) as unknown as Record<string, unknown>;
			case "library.item.update": {
				const patch = call.args["patch"] as Record<string, unknown>;
				if (
					typeof patch?.["status"] !== "string" ||
					!Number.isSafeInteger(patch?.["expected_version"]) ||
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
					String(patch["status"]),
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
				return (await runStructured(
					services.db.app,
					principal.scopes,
					call.args as unknown as QueryRequest,
				)) as unknown as Record<string, unknown>;
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
					const box = boxes[0]?.state;
					if (!box)
						throw new AssistantRuntimeError(
							"update_not_found",
							"the staged update is no longer available",
							false,
						);
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
					const pending = active[0];
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
						    and later.seq < ${emitted.seq as number}::bigint
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
					if (rolloutWon[0]?.terminal)
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
				if (!row)
					throw new AssistantRuntimeError(
						"storm_not_active",
						"this scope no longer has an active storm override",
						false,
					);
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
	// Custom bounded token bucket above is the rate limiter; CodeQL does not model Fastify-local
	// preHandlers as rate-limiting middleware. lgtm[js/missing-rate-limiting]
	app.post("/api/v1/op", { preHandler: [auth, opRateLimit] }, async (req, reply) => {
		const parsed = opCallSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: {
					code: "bad_op_call",
					message: parsed.error.issues[0]?.message ?? "invalid op call",
					retryable: false,
				},
			});
		const call = parsed.data;
		const entry = OP_BY_NAME.get(call.op);
		if (!entry)
			return opError(reply, call, 404, "unknown_op", "operation is not in the canonical catalog");
		const argsError = validateJsonSchema(call.args, entry.args);
		if (argsError) return opError(reply, call, 400, "invalid_args", argsError);
		if (entry.requires_reason && !call.reason?.trim())
			return opError(reply, call, 400, "reason_required", "this operation requires a reason");
		if (entry.human_only && (req.principal as Principal).kind !== "human")
			return opError(
				reply,
				call,
				403,
				"human_required",
				"operation is restricted to human principals",
			);
		const principal = req.principal as Principal;
		if (!principal.lanes.includes(entry.lane))
			return opError(reply, call, 403, "lane_denied", `${entry.lane} lane required`);
		const preloadedTarget =
			entry.confirm === "typed-name" ? await loadOpTarget(entry, call.args) : null;
		if (entry.confirm === "typed-name") {
			const expected =
				call.args["handle"] ??
				call.args["service"] ??
				call.args["box_id"] ??
				preloadedTarget?.["handle"] ??
				call.args["id"];
			if (
				typeof expected !== "string" ||
				String(call.args["confirm_name"] ?? "")
					.trim()
					.toLowerCase() !== expected.trim().toLowerCase()
			)
				return opError(
					reply,
					call,
					400,
					"confirmation_mismatch",
					"typed confirmation does not match the target",
				);
		}
		const authorization = await authorizeOp(entry, principal, call.args);
		if (!authorization.ok) return opError(reply, call, 403, "scope_denied", authorization.message);
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
		if (call.args["force"] === true && capabilities["force"] !== true)
			return opError(
				reply,
				call,
				403,
				"force_denied",
				"force requires server-resolved commit authority on the target",
			);
		const executor = await executorEvidence(entry, authorization.target, call.args);
		if (executor.liveness !== "alive")
			return reply.code(503).send(
				opEnvelope(call, {
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
			);
		if (!call.dry_run && entry.testable === "dry-run-only")
			return opError(
				reply,
				call,
				409,
				"dry_run_required",
				"this operation is enabled only for dry-run",
			);
		if (!call.dry_run && entry.executor !== "console-api" && !INTERNAL_OP_ADAPTERS.has(call.op))
			return opError(
				reply,
				call,
				503,
				"executor_unreachable",
				`${entry.executor} has no configured command adapter`,
				true,
			);
		const isStormRestore = call.op === "signal.snooze" && call.args["restore"] === true;
		if (!call.dry_run && !INTERNAL_OP_ADAPTERS.has(call.op) && !isStormRestore)
			return opError(
				reply,
				call,
				503,
				"executor_unreachable",
				`${call.op} has no configured command adapter`,
				true,
			);
		const callHash = createHash("sha256").update(canonicalJson(call)).digest("hex");
		let auditSeq: number | null = null;
		if (!isRead) {
			const intent = await auditIntent(call, principal, callHash);
			if (!intent.ok)
				return opError(
					reply,
					call,
					intent.code === "id_reused" ? 409 : 503,
					intent.code,
					intent.code === "id_reused"
						? "operation id was already used with a different body"
						: "intent audit could not be committed",
					intent.code !== "id_reused",
				);
			auditSeq = intent.seq;
			if (intent.duplicate) {
				const existing = await recordedOutcome(call.id);
				if (existing) return reply.send(existing);
				return opError(
					reply,
					call,
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
			if (!isRead && !(await auditOutcome(call, principal, result, "ok")))
				return opError(reply, call, 503, "audit_unavailable", "dry-run outcome audit failed", true);
			return reply.send(result);
		}
		if (proposalRequired) {
			try {
				const proposed = await maybePropose(
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
				if (!(await auditOutcome(call, principal, result, "ok")))
					return opError(
						reply,
						call,
						503,
						"audit_unavailable",
						"proposal completed but outcome audit failed",
						true,
					);
				return reply.send(result);
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
					await auditOutcome(call, principal, failed, "failed");
					return reply.code(error.code === "id_reused" ? 409 : 503).send(failed);
				}
				throw error;
			}
		}
		try {
			const operationResult = await dispatchInternalOp(call, principal);
			const undo =
				call.op === "updates.approve"
					? { op: "updates.revoke", args: { approval_id: call.id } }
					: call.op === "signal.source_mode"
						? {
								op: "signal.source_mode",
								args: {
									source_service: call.args["source_service"],
									mode:
										operationResult["previous_mode"] === "development" ? "development" : "normal",
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
			if (!isRead && !(await auditOutcome(call, principal, success, "ok")))
				return opError(
					reply,
					call,
					503,
					"audit_unavailable",
					"effect completed but outcome audit failed",
					true,
				);
			return reply.send(success);
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
			if (!isRead) await auditOutcome(call, principal, failed, "failed");
			return reply
				.code(
					retryable
						? 503
						: error instanceof CapabilityContributionError && error.code === "proposal_not_found"
							? 404
							: error instanceof CapabilityContributionError
								? 409
								: 400,
				)
				.send(failed);
		}
	});

	// --- health (unauthenticated) --------------------------------------------------------------
	app.get("/api/v1/health", async () => {
		let lake: "ok" | "down" = "ok";
		let bridges: {
			source: string;
			last_ingest_at: string | null;
			observed_at: string | null;
			lag_s: number | null;
		}[] = [];
		let ingest: { source: string; last_ingest_at: string; lag_s: number }[] = [];
		let matrixSyncOkEpoch: number | null = null;
		try {
			const now = Date.now();
			const [bridgeRows, ingestRows, matrixRows] = await Promise.all([
				services.db.admin<{ source: string; last_ingest_at: string | null }[]>`
					select c.source, max(e.received_at)::text as last_ingest_at
					from bridge_cursor c
					left join events e on e.meta #>> '{bridge_source,id}' = c.source
					group by c.source
					order by c.source`,
				services.db.admin<{ source: string; last_ingest_at: string }[]>`
					select source_service as source, max(received_at)::text as last_ingest_at
					from events group by source_service order by source_service`,
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
			}));
			const matrixEpoch = Number(matrixRows[0]?.sync_ok_epoch);
			matrixSyncOkEpoch = Number.isSafeInteger(matrixEpoch) && matrixEpoch > 0 ? matrixEpoch : null;
			await services.delivery
				.reconcileMatrixSync(matrixSyncOkEpoch)
				.catch((error) =>
					monitor.captureException(sanitizedException(error, "delivery sync health")),
				);
		} catch (error) {
			lake = "down";
			monitor.captureException(sanitizedException(error));
		}
		return {
			lake,
			seq_head: services.broker.head,
			bridges,
			ingest,
			ws_clients: wsClients,
			matrix_sync_ok_epoch: matrixSyncOkEpoch,
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
			const appendFailed = outcome.code === "append_failed";
			reply.code(
				outcome.code === "unregistered_producer"
					? 403
					: rateLimited
						? 429
						: appendFailed
							? 503
							: 400,
			);
			const retryAfterS = outcome.retryAfterS ?? (outcome.code === "emit_rate_limited" ? 60 : 3600);
			if (rateLimited) reply.header("retry-after", String(retryAfterS));
			return reply.send({
				error: {
					code: outcome.code,
					message: outcome.message,
					retryable: rateLimited || appendFailed,
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
									outcome.code === "emit_rate_limited" ||
									outcome.code === "new_type_rate_limited" ||
									outcome.code === "append_failed",
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
	app.post("/api/v1/cost/compare", { preHandler: auth }, async (req, reply) => {
		const parsed = costComparisonRequestSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: {
					code: "bad_cost_comparison",
					message: parsed.error.issues[0]?.message ?? "invalid cost comparison",
					retryable: false,
				},
			});
		const principal = req.principal as Principal;
		try {
			return await compareCostPair(
				services.db.app,
				principal.scopes,
				parsed.data,
				services.costMeter,
			);
		} catch (error) {
			if (error instanceof QueryError)
				return reply.code(400).send({
					error: { code: error.code, message: error.message, retryable: false },
				});
			if (error instanceof CostComparisonUnavailableError)
				return reply.code(503).send({
					error: { code: "cost_meter_unavailable", message: error.message, retryable: true },
				});
			throw error;
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
	app.post("/api/v1/investigations/branches", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const parsed = investigationBranchSchema.safeParse(req.body);
		if (!parsed.success)
			return reply.code(400).send({
				error: {
					code: "bad_investigation_branch",
					message: "invalid investigation branch",
					retryable: false,
				},
			});
		const input = parsed.data;
		const record = await readQueryRecord(services.db.app, p.scopes, input.panel.query_ref);
		if (!record)
			return reply.code(404).send({
				error: { code: "query_not_found", message: "parent query ref not found", retryable: false },
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
				p,
				"dashboard.save",
				input.id,
				dashboard,
				targetScope,
				"editor",
			);
			if (proposed) return proposed;
			return await saveDashboard(services.db, p, dashboard);
		} catch (error) {
			if (error instanceof ProposalError) return proposalFailure(reply, error);
			if (error instanceof DashboardError || error instanceof QueryError)
				return reply
					.code(error instanceof DashboardError && error.code === "scope_denied" ? 403 : 400)
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
	app.post("/api/v1/dashboards/:dashboardId/home", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const { dashboardId } = req.params as { dashboardId: string };
		const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(req.body);
		if (!parsed.success || !/^dash_[A-Za-z0-9_-]{8,40}$/.test(dashboardId))
			return reply.code(400).send({
				error: {
					code: "bad_dashboard",
					message: "invalid dashboard pin request",
					retryable: false,
				},
			});
		try {
			const proposed = await maybePropose(
				p,
				"dashboard.set_home",
				parsed.data.id,
				{ id: dashboardId },
				`user:${p.id}`,
				"owner",
			);
			if (proposed) return proposed;
			return await setHomeDashboard(services.db.writer, p, dashboardId);
		} catch (error) {
			if (error instanceof ProposalError) return proposalFailure(reply, error);
			if (error instanceof DashboardError)
				return reply
					.code(error.code === "scope_denied" ? 403 : 404)
					.send({ error: { code: error.code, message: error.message, retryable: false } });
			throw error;
		}
	});

	// --- Rev3 Library: one scope-filtered item/link store + the fleet capability registry ------
	async function libraryRead(
		reply: FastifyReply,
		read: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		try {
			return await read();
		} catch (error) {
			if (error instanceof DashboardError)
				return reply
					.code(400)
					.send({ error: { code: error.code, message: error.message, retryable: false } });
			throw error;
		}
	}
	app.get("/api/v1/library/items", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { q?: string; kind?: string; limit?: string; cursor?: string };
		return libraryRead(reply, () =>
			listLibraryItems(services.db.app, p.scopes, services.cursorSecret, {
				...(query.q ? { query: query.q } : {}),
				...(query.kind ? { kind: query.kind } : {}),
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
			}),
		);
	});
	app.get("/api/v1/library/search", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { q?: string; kind?: string; limit?: string; cursor?: string };
		if (!query.q?.trim())
			return reply.code(400).send({
				error: { code: "bad_library_query", message: "q is required", retryable: false },
			});
		return libraryRead(reply, () =>
			listLibraryItems(services.db.app, p.scopes, services.cursorSecret, {
				query: query.q!,
				...(query.kind ? { kind: query.kind } : {}),
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
			}),
		);
	});
	app.get("/api/v1/library/items/:itemId", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const { itemId } = req.params as { itemId: string };
		if (!/^[A-Za-z0-9:_-]{1,128}$/.test(itemId))
			return reply.code(404).send({
				error: {
					code: "library_item_not_found",
					message: "Library item not found",
					retryable: false,
				},
			});
		const item = await readLibraryItem(services.db.app, p.scopes, itemId);
		return (
			item ??
			reply.code(404).send({
				error: {
					code: "library_item_not_found",
					message: "Library item not found",
					retryable: false,
				},
			})
		);
	});
	app.get("/api/v1/library/items/:itemId/history", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const { itemId } = req.params as { itemId: string };
		if (!/^[A-Za-z0-9:_-]{1,128}$/.test(itemId))
			return reply.code(404).send({
				error: {
					code: "library_item_not_found",
					message: "Library item not found",
					retryable: false,
				},
			});
		return libraryRead(reply, () => readLibraryItemHistory(services.db.app, p.scopes, itemId));
	});
	app.get("/api/v1/library/links", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { item_id?: string; limit?: string; cursor?: string };
		return libraryRead(reply, () =>
			listLibraryLinks(services.db.app, p.scopes, services.cursorSecret, query.item_id, {
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
			}),
		);
	});
	app.get("/api/v1/library/holds", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { limit?: string; cursor?: string };
		return libraryRead(reply, () =>
			listLibraryHolds(services.db.app, p.scopes, p.id, services.cursorSecret, {
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
			}),
		);
	});
	app.get("/api/v1/library/curation", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { limit?: string; cursor?: string };
		return libraryRead(reply, () =>
			listLibraryCuration(services.db.app, p.scopes, services.cursorSecret, {
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
			}),
		);
	});
	app.get("/api/v1/library/capabilities", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const query = req.query as { limit?: string; cursor?: string };
		return libraryRead(reply, () =>
			listLibraryCapabilities(services.db.app, p.scopes, services.cursorSecret, {
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
			}),
		);
	});
	app.post(
		"/api/v1/library/capabilities/:capability/acquire",
		{ preHandler: auth },
		async (req, reply) => {
			const principal = req.principal as Principal;
			const { capability } = req.params as { capability: string };
			const body = z
				.object({ provider: z.string().optional() })
				.strict()
				.safeParse(req.body ?? {});
			if (!body.success)
				return reply.code(400).send({
					error: {
						code: "bad_capability",
						message: "invalid capability acquisition request",
						retryable: false,
					},
				});
			try {
				return await acquireCapability(
					services.db.app,
					principal.scopes,
					capability,
					body.data.provider,
				);
			} catch (error) {
				if (error instanceof CapabilityAcquisitionError) {
					const status =
						error.code === "bad_capability"
							? 400
							: error.code === "capability_not_found"
								? 404
								: 422;
					return reply.code(status).send({
						error: { code: error.code, message: error.message, retryable: false },
					});
				}
				throw error;
			}
		},
	);

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

	// --- global command palette ------------------------------------------------------------------
	// One scope-filtered retrieval seam for the shell. Surfaces and safe quick actions stay local
	// (they are static capability-aware navigation); operational objects are always read as-caller.
	app.get("/api/v1/palette/search", { preHandler: auth }, async (req, reply) => {
		const principal = req.principal as Principal;
		const query = req.query as Record<string, unknown>;
		const text = typeof query["q"] === "string" ? query["q"].trim() : "";
		if (!text || text.length > 100)
			return reply.code(400).send({
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
			return reply.code(400).send({
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
				const handle = String(agent["handle"] ?? "");
				if (!handle) continue;
				const displayName = String(agent["display_name"] ?? handle);
				const host = typeof agent["host"] === "string" ? agent["host"] : null;
				const role = typeof agent["role"] === "string" ? agent["role"] : "agent";
				candidates.push({
					id: `agent:${handle}`,
					kind: "agent",
					label: displayName,
					description: `@${handle} · ${role}${host ? ` · ${host}` : ""}`,
					href: `/agents?agent=${encodeURIComponent(handle)}`,
					keywords: [handle, role, host ?? "", String(agent["capabilities"] ?? "")],
					meta: agent["active"] === 0 ? "inactive" : "resident",
				});
			}
		}
		if (tasks.status === "fulfilled") {
			for (const task of tasks.value) {
				const id = Number(task["id"]);
				const title = String(task["title"] ?? "");
				if (!Number.isSafeInteger(id) || id < 1 || !title) continue;
				const status = String(task["status"] ?? "unknown");
				const project = typeof task["project_name"] === "string" ? task["project_name"] : null;
				const owner = String(
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
				const id = String(item["id"] ?? "");
				const title = String(item["title"] ?? "");
				if (!id || !title) continue;
				const kind = String(item["kind"] ?? "item");
				const project = String(item["project"] ?? "unfiled");
				candidates.push({
					id: `library:${id}`,
					kind: "library",
					label: title,
					description: `${kind} · ${project}`,
					href: `/library?item=${encodeURIComponent(id)}`,
					keywords: [id, kind, project, String(item["status"] ?? "")],
					meta: String(item["status"] ?? ""),
				});
			}
		}
		if (hosts.status === "fulfilled") {
			for (const host of hosts.value.items) {
				const hostname = String(host["hostname"] ?? host["box_id"] ?? host["subject"] ?? "");
				if (!hostname) continue;
				const status = String(host["status"] ?? "unknown").replaceAll("_", " ");
				candidates.push({
					id: `host:${hostname}`,
					kind: "host",
					label: hostname,
					description: `Host · ${status}`,
					href: `/hosts?host=${encodeURIComponent(hostname)}`,
					keywords: [String(host["box_id"] ?? ""), status, String(host["os_family"] ?? "")],
					meta: String(host["last_checked_at"] ?? host["observed_at"] ?? ""),
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
		return {
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
		};
	});

	// --- typed entity reads (RLS-scoped projections, N1b) -----------------------------------------
	registerEntityReadRoutes(app, { app: services.db.app, auth });
	app.get("/api/v1/network/key-ceremony", { preHandler: auth }, async (req) => {
		const principal = req.principal as Principal;
		const registry = await readEntity(services.db.app, principal.scopes, "edge", {
			limit: 1_000,
			requiredFields: ["pubkey_fp", "state"],
		});
		const configured = services.keyCeremony !== null;
		const live = configured ? await services.keyCeremony!.health() : false;
		return {
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
		};
	});

	app.get("/api/v1/update-approvals", { preHandler: auth }, async (request, reply) => {
		const principal = request.principal as Principal;
		const query = request.query as {
			box_id?: string;
			limit?: string;
			cursor?: string;
			since?: string;
		};
		const boxId = query.box_id;
		if (!boxId || boxId.length > 256)
			return reply.code(400).send({
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
			(query.cursor && !z.string().uuid().safeParse(query.cursor).success) ||
			(query.since && Number.isNaN(Date.parse(query.since)))
		)
			return reply.code(400).send({
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
		return {
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
		};
	});

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
	app.get("/api/v1/work/settlement", { preHandler: auth }, async (req, reply) => {
		if (!trackerOr503(reply)) return reply;
		return readWorkSettlement(
			services.tracker as TrackerReader,
			(req.principal as Principal).scopes,
		);
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

	// --- terminal gate + frame transport --------------------------------------------------------
	// `config.rateLimit` mirrors the custom bucket for Fastify/CodeQL route metadata; the preHandler
	// is the runtime enforcement, avoiding a second limiter with divergent counters.
	app.get(
		"/api/v1/terminal",
		{
			preHandler: [auth, opRateLimit],
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (req, reply) => {
			const principal = req.principal as Principal;
			const denial = await authorizeTerminal(principal);
			if (denial) {
				const auditSeq = await emitTerminalAudit(principal, "denied", null, null, denial);
				if (auditSeq === null)
					return reply.code(503).send({
						error: {
							code: "audit_unavailable",
							message: "terminal denial could not be retained",
							retryable: true,
						},
					});
				return reply.code(403).send({
					error: { code: "term_denied", message: "term_admin access required", retryable: false },
				});
			}
			const auditSeq = await emitTerminalAudit(principal, "access", null, null);
			if (auditSeq === null)
				return reply.code(503).send({
					error: {
						code: "audit_unavailable",
						message: "terminal audit write could not be verified",
						retryable: true,
					},
				});
			return { audit_writable: true, pty_live: await terminal.health(), audit_seq: auditSeq };
		},
	);

	app.post(
		"/api/v1/terminal/peek",
		{
			preHandler: [auth, opRateLimit],
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (req, reply) => {
			const principal = req.principal as Principal;
			const denial = await authorizeTerminal(principal);
			if (denial) {
				const auditSeq = await emitTerminalAudit(principal, "denied", null, null, denial);
				return reply.code(auditSeq === null ? 503 : 403).send({
					error: {
						code: auditSeq === null ? "audit_unavailable" : "term_denied",
						message: auditSeq === null ? "terminal denial could not be retained" : denial,
						retryable: auditSeq === null,
					},
				});
			}
			const parsed = terminalTargetSchema.safeParse(req.body);
			if (!parsed.success)
				return reply.code(400).send({
					error: { code: "invalid_target", message: "invalid terminal target", retryable: false },
				});
			if (!(await terminal.health()))
				return reply.code(503).send({
					error: { code: "pty_unavailable", message: "PTY adapter unavailable", retryable: true },
				});
			const streamId = crypto.randomUUID();
			const target: TerminalTarget = {
				host: parsed.data.host,
				tmuxSession: parsed.data.tmux_session,
				paneId: parsed.data.pane_id,
			};
			if (!(await visibleResidentTarget(principal, target)))
				return reply.code(404).send({
					error: {
						code: "pane_not_visible",
						message: "resident terminal pane is not visible",
						retryable: false,
					},
				});
			const auditSeq = await emitTerminalAudit(principal, "watch", target, streamId);
			if (auditSeq === null)
				return reply.code(503).send({
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
				return {
					schema_version: 1,
					stream_id: streamId,
					seq: session.seq,
					audit_seq: auditSeq,
					data_b64: snapshot.toString("base64"),
				};
			} catch (error) {
				if (session.timer) clearTimeout(session.timer);
				terminalSessions.delete(streamId);
				monitor.captureException(sanitizedException(error));
				return reply.code(502).send({
					error: {
						code: "pty_capture_failed",
						message: "terminal capture failed",
						retryable: true,
					},
				});
			}
		},
	);

	app.get(
		"/api/v1/terminal/peek/:streamId",
		{
			preHandler: [auth, opRateLimit],
			config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
		},
		async (req, reply) => {
			const session = await ownedTerminalSession(req, reply);
			if (!session) return reply;
			if (session.timer) clearTimeout(session.timer);
			session.timer = setTimeout(() => {
				session.closed = true;
				terminalSessions.delete((req.params as { streamId: string }).streamId);
			}, 30_000);
			session.timer.unref();
			try {
				const snapshot = await terminal.capture(session.target, 10_000);
				session.seq += 1;
				return {
					schema_version: 1,
					stream_id: (req.params as { streamId: string }).streamId,
					seq: session.seq,
					data_b64: snapshot.toString("base64"),
				};
			} catch (error) {
				monitor.captureException(sanitizedException(error));
				return reply.code(502).send({
					error: {
						code: "pty_capture_failed",
						message: "terminal capture failed",
						retryable: true,
					},
				});
			}
		},
	);

	app.post(
		"/api/v1/terminal/streams",
		{
			preHandler: [auth, opRateLimit],
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (req, reply) => {
			const principal = req.principal as Principal;
			const denial = await authorizeTerminal(principal);
			if (denial) {
				const auditSeq = await emitTerminalAudit(principal, "denied", null, null, denial);
				return reply.code(auditSeq === null ? 503 : 403).send({
					error: {
						code: auditSeq === null ? "audit_unavailable" : "term_denied",
						message: auditSeq === null ? "terminal denial could not be retained" : denial,
						retryable: auditSeq === null,
					},
				});
			}
			const parsed = terminalTargetSchema.safeParse(req.body);
			if (!parsed.success)
				return reply.code(400).send({
					error: { code: "invalid_target", message: "invalid terminal target", retryable: false },
				});
			if (!(await terminal.health()))
				return reply.code(503).send({
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
				return reply.code(503).send({
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
			reply.hijack();
			reply.raw.writeHead(200, {
				"cache-control": "no-store",
				"content-type": "application/x-ndjson; charset=utf-8",
				"x-accel-buffering": "no",
			});
			const write = (frame: Record<string, unknown>): boolean =>
				!reply.raw.destroyed &&
				reply.raw.write(
					`${JSON.stringify({ schema_version: 1, stream_id: streamId, ...frame })}\n`,
				);
			const waitForDrain = async (): Promise<void> => {
				if (reply.raw.destroyed || !reply.raw.writableNeedDrain) return;
				await new Promise<void>((resolve) => {
					const done = (): void => {
						reply.raw.off("drain", done);
						reply.raw.off("close", done);
						resolve();
					};
					reply.raw.once("drain", done);
					reply.raw.once("close", done);
				});
			};
			write({ kind: "open", seq: session.seq, audit_seq: auditSeq, mode: "read" });
			let previous: Buffer | null = null;
			const pump = async (): Promise<void> => {
				if (session.closed || reply.raw.destroyed) return;
				try {
					const fresh = await resolveRequestPrincipal(req);
					const revoked =
						!fresh || fresh.id !== session.principalId || (await authorizeTerminal(fresh)) !== null;
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
						reply.raw.end();
						return;
					}
					const frame = await terminal.capture(target, parsed.data.scrollback_lines);
					if (!previous?.equals(frame)) {
						previous = frame;
						session.seq += 1;
						if (!write({ kind: "snapshot", seq: session.seq, data_b64: frame.toString("base64") }))
							await waitForDrain();
					}
				} catch (error) {
					monitor.captureException(sanitizedException(error));
					session.closed = true;
					session.seq += 1;
					write({ kind: "error", seq: session.seq, code: "pty_capture_failed" });
					reply.raw.end();
					return;
				}
				if (!session.closed && !reply.raw.destroyed) session.timer = setTimeout(pump, 750);
			};
			void pump();
			const close = (): void => {
				session.closed = true;
				if (session.timer) clearTimeout(session.timer);
				terminalSessions.delete(streamId);
			};
			session.end = () => reply.raw.end();
			reply.raw.on("close", close);
		},
	);

	app.post(
		"/api/v1/terminal/streams/:streamId/attach",
		{
			preHandler: [auth, opRateLimit],
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (req, reply) => {
			const session = await ownedTerminalSession(req, reply);
			if (!session) return reply;
			if (!session.writable)
				return reply.code(409).send({
					error: {
						code: "watch_only",
						message: "read-only peek sessions cannot attach",
						retryable: false,
					},
				});
			const principal = req.principal as Principal;
			const streamId = (req.params as { streamId: string }).streamId;
			const auditSeq = await emitTerminalAudit(principal, "attach", session.target, streamId);
			if (auditSeq === null)
				return reply.code(503).send({
					error: { code: "audit_unavailable", message: "attach audit failed", retryable: true },
				});
			session.attached = true;
			return { ok: true, mode: "write", audit_seq: auditSeq };
		},
	);

	app.post(
		"/api/v1/terminal/streams/:streamId/input",
		{
			preHandler: [auth, opRateLimit],
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (req, reply) => {
			const session = await ownedTerminalSession(req, reply);
			if (!session) return reply;
			if (!session.attached)
				return reply.code(409).send({
					error: { code: "watch_only", message: "attach before sending input", retryable: false },
				});
			const parsed = terminalInputSchema.safeParse(req.body);
			if (!parsed.success)
				return reply.code(400).send({
					error: { code: "invalid_input", message: "invalid terminal input", retryable: false },
				});
			const data = Buffer.from(parsed.data.data_b64, "base64");
			if (data.length > 16_384)
				return reply.code(413).send({
					error: { code: "input_too_large", message: "terminal input too large", retryable: false },
				});
			const principal = req.principal as Principal;
			const streamId = (req.params as { streamId: string }).streamId;
			const auditSeq = await emitTerminalAudit(principal, "input", session.target, streamId);
			if (auditSeq === null)
				return reply.code(503).send({
					error: { code: "audit_unavailable", message: "input audit failed", retryable: true },
				});
			try {
				await terminal.input(session.target, data);
				return { ok: true, audit_seq: auditSeq };
			} catch (error) {
				monitor.captureException(sanitizedException(error));
				return reply.code(503).send({
					error: { code: "pty_input_failed", message: "terminal input failed", retryable: true },
				});
			}
		},
	);

	app.post(
		"/api/v1/terminal/streams/:streamId/detach",
		{
			preHandler: [auth, opRateLimit],
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (req, reply) => {
			const session = await ownedTerminalSession(req, reply);
			if (!session) return reply;
			const principal = req.principal as Principal;
			const streamId = (req.params as { streamId: string }).streamId;
			const auditSeq = await emitTerminalAudit(principal, "detach", session.target, streamId);
			if (auditSeq === null)
				return reply.code(503).send({
					error: { code: "audit_unavailable", message: "detach audit failed", retryable: true },
				});
			session.closed = true;
			if (session.timer) clearTimeout(session.timer);
			terminalSessions.delete(streamId);
			session.end();
			return { ok: true, audit_seq: auditSeq };
		},
	);

	app.addHook("onClose", async () => {
		for (const session of terminalSessions.values()) {
			session.closed = true;
			if (session.timer) clearTimeout(session.timer);
		}
		terminalSessions.clear();
	});

	// --- bus WS ----------------------------------------------------------------------------------
	app.get("/api/v1/bus/ws", { websocket: true }, (socket, req) => {
		const maxFrameBytes = 16 * 1024;
		const maxSubscriptions = 64;
		const connectionId = crypto.randomUUID();
		wsClients += 1;
		let clientCounted = true;
		let principal: Principal | null = null;
		const authz = req.headers.authorization;
		const connSubs = new Set<string>();
		const send = (frame: Record<string, unknown>): void => {
			if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
		};
		const bearer = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
		const ready = (async () => {
			try {
				principal = await resolveRequestPrincipal(req);
			} catch {
				principal = null;
			}
			if (!principal) {
				send({
					schema_version: 1,
					kind: "ack",
					sub_id: "*",
					replay_through_seq: 0,
					error: { code: "unauthorized", message: "valid credentials required", retryable: false },
				});
				socket.close();
			}
		})();
		let heartbeatRunning = false;
		const sendHeartbeat = async (): Promise<void> => {
			if (!principal || heartbeatRunning || socket.readyState !== socket.OPEN) return;
			heartbeatRunning = true;
			const ts = new Date();
			let ingest: Record<string, number> | null = null;
			try {
				const rows = await withScopes(
					services.db.app,
					principal.scopes,
					async (tx) =>
						tx<{ source_service: string; last_received_at: string }[]>`
						select source_service, max(received_at)::text as last_received_at
						from events
						group by source_service`,
				);
				ingest = Object.fromEntries(
					rows.map((row) => [
						row.source_service,
						Math.max(0, (ts.getTime() - Date.parse(row.last_received_at)) / 1000),
					]),
				);
			} catch (error) {
				monitor.captureException(sanitizedException(error));
			} finally {
				heartbeatRunning = false;
			}
			send({
				schema_version: 1,
				kind: "heartbeat",
				ts: ts.toISOString(),
				seq_head: services.broker.head,
				ingest,
			});
		};
		void ready.then(sendHeartbeat);
		const heartbeatTimer = setInterval(() => {
			void sendHeartbeat();
		}, 15000);
		heartbeatTimer.unref();

		// LISTEN/NOTIFY makes grant changes re-fence immediately. The 30s check remains as a recovery
		// path for token revocation and a notification connection blip.
		let refreshing = false;
		let refreshAgain = false;
		const refreshPrincipal = async (): Promise<void> => {
			if (refreshing) {
				refreshAgain = true;
				return;
			}
			refreshing = true;
			try {
				const fresh = await resolveRequestPrincipal(req);
				if (!fresh) {
					for (const id of connSubs) services.broker.unsubscribe(connectionId, id);
					socket.close();
					return;
				}
				principal = fresh;
				services.broker.revalidateScopes(connectionId, [...connSubs], fresh.scopes);
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
		const refreshable = Boolean(bearer || browserAuth);
		const stopGrantWatch = refreshable
			? services.onGrantChange(() => {
					principal = null;
					services.broker.revalidateScopes(connectionId, [...connSubs], []);
					void refreshPrincipal();
				})
			: null;
		const revalidateTimer = refreshable
			? setInterval(() => {
					void refreshPrincipal();
				}, 30000)
			: null;
		if (revalidateTimer) revalidateTimer.unref();

		socket.on("message", (data: Buffer) => {
			void (async () => {
				await ready;
				if (!principal) return;
				const rejectFrame = (code: string, message: string, subId = "?"): void => {
					send({
						schema_version: 1,
						kind: "ack",
						sub_id: subId,
						replay_through_seq: services.broker.head,
						error: { code, message, retryable: false },
					});
				};
				if (data.byteLength > maxFrameBytes) {
					rejectFrame("frame_too_large", `frame exceeds ${String(maxFrameBytes)} bytes`);
					return;
				}
				let raw: unknown;
				try {
					raw = JSON.parse(data.toString()) as unknown;
				} catch {
					rejectFrame("bad_frame", "invalid json");
					return;
				}
				const rawSubId =
					raw && typeof raw === "object" ? (raw as Record<string, unknown>)["sub_id"] : undefined;
				const candidateSubId =
					typeof rawSubId === "string" && rawSubId.length <= 64 ? rawSubId : "?";
				const contractError = validateJsonSchema(
					raw,
					clientBusFrameSchema,
					"frame",
					busFrameSchema,
				);
				if (contractError) {
					rejectFrame("invalid_frame", "frame does not match the bus contract", candidateSubId);
					return;
				}
				const msg = raw as {
					schema_version: 1;
					action: "subscribe" | "unsubscribe";
					sub_id: string;
					pattern?: string;
					filter?: SubscribeSpec["filter"];
					since?: number;
				};
				if (msg.action === "subscribe") {
					if (!connSubs.has(msg.sub_id) && connSubs.size >= maxSubscriptions) {
						rejectFrame(
							"subscription_limit",
							`connection is limited to ${String(maxSubscriptions)} subscriptions`,
							msg.sub_id,
						);
						return;
					}
					const spec: SubscribeSpec = {
						subId: msg.sub_id,
						pattern: msg.pattern as string,
						filter: msg.filter,
						since: msg.since,
						scopes: principal.scopes,
					};
					await services.broker.subscribe(connectionId, spec, send, () => {
						connSubs.add(msg.sub_id);
					});
				} else {
					services.broker.unsubscribe(connectionId, msg.sub_id);
					connSubs.delete(msg.sub_id);
				}
			})();
		});
		socket.on("close", () => {
			if (clientCounted) {
				clientCounted = false;
				wsClients = Math.max(0, wsClients - 1);
			}
			clearInterval(heartbeatTimer);
			if (revalidateTimer) clearInterval(revalidateTimer);
			stopGrantWatch?.();
			for (const id of connSubs) services.broker.unsubscribe(connectionId, id);
		});
	});

	return app;
}

// entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
	const env = loadEnv();
	const monitor = initExceptionMonitor(env.glitchtipDsn);
	const services = await buildServices(env, { monitor });
	const server = await buildServer(services, env.devAuth, monitor, env.browserAuth);
	await server.listen({ host: env.host, port: env.port });
	process.stdout.write(`console-api listening on ${env.host}:${String(env.port)}\n`);
}
