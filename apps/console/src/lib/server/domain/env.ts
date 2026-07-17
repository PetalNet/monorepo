// Runtime configuration, read once at boot. Nothing here is secret-bearing beyond
// connection URLs (which carry credentials) — those come from the environment, never code.

import type { MatrixConfig } from "./notifications/matrix.ts";

export interface Env {
	/** Admin/owner connection: migrations, seeding, the appender's INSERT path. */
	readonly databaseUrl: string;
	/**
	 * Runtime scoped-read connection (role console_app, non-BYPASSRLS). Falls back to databaseUrl in
	 * dev.
	 */
	readonly appDatabaseUrl: string;
	/** Read-only SQL-mode connection (role console_ro). Falls back to appDatabaseUrl in dev. */
	readonly roDatabaseUrl: string;
	/**
	 * The appender's writer connection (role console_writer, non-superuser). Falls back to
	 * databaseUrl in dev.
	 */
	readonly writerDatabaseUrl: string;
	readonly host: string;
	readonly port: number;
	/**
	 * When true, bearer auth accepts a dev principal header for local testing only. Never set in
	 * prod.
	 */
	readonly devAuth: boolean;
	readonly devAuthHost?: string | null;
	readonly glitchtipDsn: string | null;
	/** HMAC key for opaque pagination cursors. Required outside dev-auth test/local mode. */
	readonly cursorSecret?: string;
	/**
	 * Read-only path to the tasks tracker SQLite (single-writer store read for /tasks /leases
	 * /agents).
	 */
	readonly trackerDbPath: string | null;
	/** Canonical tracker agent-RPC writer used for propose-not-commit. */
	readonly trackerRpcUrl?: string | null;
	readonly trackerRpcToken?: string | null;
	readonly trackerProposalProject?: string | null;
	/** OpenAI-compatible chat-completions endpoint used by the scoped dashboard compiler. */
	readonly assistantLlmUrl?: string | null;
	readonly assistantLlmModel?: string | null;
	readonly assistantLlmApiKey?: string | null;
	/** Phase 5 per-user Claude Code manager seam. */
	readonly assistantManagerUrl?: string | null;
	readonly assistantManagerToken?: string | null;
	readonly publicConsoleUrl?: string | null;
	/** AgentsView read API used until the BR-033 Postgres mirror is registered. */
	readonly costMeterUrl?: string | null;
	readonly costMeterHostHeader?: string | null;
	readonly costMeterToken?: string | null;
	/** Private doorman-edge administration API used by the Network Key Ceremony. */
	readonly doormanAdminUrl?: string | null;
	readonly doormanAdminToken?: string | null;
	/** Matrix is the decided off-console notification channel; all three values configure it. */
	readonly matrix?: MatrixConfig | null;
	readonly betterAuth: { readonly baseUrl: string; readonly secret: string } | null;
}

function required(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
	return v;
}

export function loadEnv(): Env {
	const databaseUrl = required("DATABASE_URL");
	const devAuth = process.env["CONSOLE_API_DEV_AUTH"] === "1";
	if (
		devAuth &&
		process.env["NODE_ENV"] === "production" &&
		process.env["CONSOLE_API_DEV_AUTH_HOST"] !== "console-demo.petalcat.dev"
	)
		throw new Error("production dev-auth is restricted to console-demo.petalcat.dev");
	const configuredCostMeterUrl = process.env["CONSOLE_COST_METER_URL"];
	const costMeterUrl = configuredCostMeterUrl ?? "http://127.0.0.1:8098/api/v1";
	const parsedCostMeterUrl = new URL(costMeterUrl);
	if (
		!devAuth &&
		parsedCostMeterUrl.protocol !== "https:" &&
		!new Set(["127.0.0.1", "::1", "localhost"]).has(parsedCostMeterUrl.hostname)
	)
		throw new Error("CONSOLE_COST_METER_URL must use https or a loopback host");
	const matrixValues = [
		process.env["CONSOLE_API_MATRIX_HOMESERVER"],
		process.env["CONSOLE_API_MATRIX_ACCESS_TOKEN"],
		process.env["CONSOLE_API_MATRIX_OWNER_BINDINGS"],
	];
	const doormanValues = [
		process.env["CONSOLE_DOORMAN_ADMIN_URL"],
		process.env["CONSOLE_DOORMAN_ADMIN_TOKEN"],
	];
	if (doormanValues.some(Boolean) && !doormanValues.every(Boolean))
		throw new Error(
			"CONSOLE_DOORMAN_ADMIN_URL and CONSOLE_DOORMAN_ADMIN_TOKEN must be configured together",
		);
	if (doormanValues.every(Boolean)) {
		const endpoint = new URL(doormanValues[0]!);
		if (
			!devAuth &&
			endpoint.protocol !== "https:" &&
			!new Set(["127.0.0.1", "::1", "localhost"]).has(endpoint.hostname)
		)
			throw new Error("CONSOLE_DOORMAN_ADMIN_URL must use https or a loopback host");
		if ((doormanValues[1] ?? "").length < 32)
			throw new Error("CONSOLE_DOORMAN_ADMIN_TOKEN must contain at least 32 characters");
	}
	if (matrixValues.some(Boolean) && !matrixValues.every(Boolean))
		throw new Error(
			"CONSOLE_API_MATRIX_HOMESERVER, CONSOLE_API_MATRIX_ACCESS_TOKEN, and CONSOLE_API_MATRIX_OWNER_BINDINGS must be configured together",
		);
	let matrix: MatrixConfig | null = null;
	if (matrixValues.every(Boolean)) {
		const homeserver = new URL(matrixValues[0]!);
		if (homeserver.protocol !== "https:" || homeserver.pathname !== "/")
			throw new Error("CONSOLE_API_MATRIX_HOMESERVER must be an HTTPS origin");
		let ownerBindings: unknown;
		try {
			ownerBindings = JSON.parse(matrixValues[2]!);
		} catch {
			throw new Error("CONSOLE_API_MATRIX_OWNER_BINDINGS must be a JSON object");
		}
		if (
			!ownerBindings ||
			typeof ownerBindings !== "object" ||
			Array.isArray(ownerBindings) ||
			Object.entries(ownerBindings).some(
				([owner, userId]) =>
					!/^[a-z0-9][a-z0-9._-]*$/.test(owner) ||
					typeof userId !== "string" ||
					!/^@[^:]+:.+$/.test(userId),
			)
		)
			throw new Error(
				"CONSOLE_API_MATRIX_OWNER_BINDINGS must map console principals to Matrix user ids",
			);
		matrix = {
			homeserver: homeserver.origin,
			accessToken: matrixValues[1]!,
			ownerBindings: ownerBindings as Record<string, string>,
		};
	}
	const betterAuthUrl = process.env["BETTER_AUTH_URL"];
	const betterAuthSecret = process.env["BETTER_AUTH_SECRET"];
	if (Boolean(betterAuthUrl) !== Boolean(betterAuthSecret))
		throw new Error("BETTER_AUTH_URL and BETTER_AUTH_SECRET must be configured together");
	let betterAuth: Env["betterAuth"] = null;
	if (betterAuthUrl && betterAuthSecret) {
		const parsed = new URL(betterAuthUrl);
		if (!devAuth && parsed.protocol !== "https:")
			throw new Error("BETTER_AUTH_URL must use https outside dev-auth mode");
		if (betterAuthSecret.length < 32)
			throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
		betterAuth = { baseUrl: betterAuthUrl, secret: betterAuthSecret };
	}
	if (!devAuth && !betterAuth)
		throw new Error("browser auth is required outside dev: configure Better Auth");
	return {
		databaseUrl,
		appDatabaseUrl: process.env["APP_DATABASE_URL"] ?? databaseUrl,
		roDatabaseUrl: process.env["RO_DATABASE_URL"] ?? process.env["APP_DATABASE_URL"] ?? databaseUrl,
		writerDatabaseUrl: process.env["WRITER_DATABASE_URL"] ?? databaseUrl,
		host: process.env["CONSOLE_API_HOST"] ?? "127.0.0.1",
		port: Number(process.env["CONSOLE_API_PORT"] ?? "8080"),
		devAuth,
		devAuthHost:
			devAuth && process.env["NODE_ENV"] === "production" ? "console-demo.petalcat.dev" : null,
		glitchtipDsn: process.env["CONSOLE_API_GLITCHTIP_DSN"] ?? null,
		...(process.env["CONSOLE_API_CURSOR_SECRET"]
			? { cursorSecret: process.env["CONSOLE_API_CURSOR_SECRET"] }
			: {}),
		trackerDbPath: process.env["TRACKER_DB_PATH"] ?? null,
		trackerRpcUrl: process.env["TRACKER_RPC_URL"] ?? null,
		trackerRpcToken: process.env["TRACKER_RPC_TOKEN"] ?? null,
		trackerProposalProject: process.env["TRACKER_PROPOSAL_PROJECT"] ?? null,
		assistantLlmUrl: process.env["CONSOLE_ASSISTANT_LLM_URL"] ?? null,
		assistantLlmModel: process.env["CONSOLE_ASSISTANT_LLM_MODEL"] ?? null,
		assistantLlmApiKey: process.env["CONSOLE_ASSISTANT_LLM_API_KEY"] ?? null,
		assistantManagerUrl: process.env["CONSOLE_ASSISTANT_MANAGER_URL"] ?? null,
		assistantManagerToken: process.env["CONSOLE_ASSISTANT_MANAGER_TOKEN"] ?? null,
		publicConsoleUrl: process.env["CONSOLE_API_PUBLIC_URL"] ?? null,
		costMeterUrl,
		costMeterHostHeader:
			process.env["CONSOLE_COST_METER_HOST"] ?? (configuredCostMeterUrl ? null : "localhost:8080"),
		costMeterToken: process.env["CONSOLE_COST_METER_TOKEN"] ?? null,
		doormanAdminUrl: doormanValues[0] ?? null,
		doormanAdminToken: doormanValues[1] ?? null,
		matrix,
		betterAuth,
	};
}
