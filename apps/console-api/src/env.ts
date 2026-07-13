// Runtime configuration, read once at boot. Nothing here is secret-bearing beyond
// connection URLs (which carry credentials) — those come from the environment, never code.

import { isIP } from "node:net";

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
	/** Strict browser boundary. Null only in explicit dev-auth mode. */
	readonly browserAuth: {
		readonly consoleOrigin: string;
		readonly proxyNonce: string;
		readonly trustedProxies: readonly string[];
	} | null;
}

function required(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
	return v;
}

export function loadEnv(): Env {
	const databaseUrl = required("DATABASE_URL");
	const devAuth = process.env["CONSOLE_API_DEV_AUTH"] === "1";
	const consoleOrigin = process.env["CONSOLE_API_CORS_ORIGIN"];
	const proxyNonce = process.env["CONSOLE_API_AUTH_PROXY_NONCE"];
	const trustedProxies = (process.env["CONSOLE_API_TRUSTED_PROXIES"] ?? "")
		.split(",")
		.map((proxy) => proxy.trim())
		.filter(Boolean);
	let browserAuth: Env["browserAuth"] = null;
	if (consoleOrigin || proxyNonce || trustedProxies.length > 0) {
		if (!consoleOrigin || !proxyNonce || trustedProxies.length === 0)
			throw new Error(
				"CONSOLE_API_CORS_ORIGIN, CONSOLE_API_AUTH_PROXY_NONCE, and CONSOLE_API_TRUSTED_PROXIES must be configured together",
			);
		const parsedOrigin = new URL(consoleOrigin);
		if (
			(parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:") ||
			parsedOrigin.origin !== consoleOrigin
		)
			throw new Error("CONSOLE_API_CORS_ORIGIN must be one exact HTTP(S) origin");
		if (proxyNonce.length < 32)
			throw new Error("CONSOLE_API_AUTH_PROXY_NONCE must contain at least 32 characters");
		if (trustedProxies.some((proxy) => isIP(proxy) === 0))
			throw new Error("CONSOLE_API_TRUSTED_PROXIES must contain only exact IP addresses");
		browserAuth = { consoleOrigin, proxyNonce, trustedProxies };
	} else if (!devAuth) {
		throw new Error(
			"browser auth is required outside dev: configure exact CORS origin, per-boot proxy nonce, and trusted proxies",
		);
	}
	return {
		databaseUrl,
		appDatabaseUrl: process.env["APP_DATABASE_URL"] ?? databaseUrl,
		roDatabaseUrl: process.env["RO_DATABASE_URL"] ?? process.env["APP_DATABASE_URL"] ?? databaseUrl,
		writerDatabaseUrl: process.env["WRITER_DATABASE_URL"] ?? databaseUrl,
		host: process.env["CONSOLE_API_HOST"] ?? "127.0.0.1",
		port: Number(process.env["CONSOLE_API_PORT"] ?? "8080"),
		devAuth,
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
		browserAuth,
	};
}
