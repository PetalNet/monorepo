// Runtime configuration, read once at boot. Nothing here is secret-bearing beyond
// connection URLs (which carry credentials) — those come from the environment, never code.

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
	/** OpenAI-compatible chat-completions endpoint used by the scoped dashboard compiler. */
	readonly assistantLlmUrl?: string | null;
	readonly assistantLlmModel?: string | null;
	readonly assistantLlmApiKey?: string | null;
}

function required(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
	return v;
}

export function loadEnv(): Env {
	const databaseUrl = required("DATABASE_URL");
	const devAuth = process.env["CONSOLE_API_DEV_AUTH"] === "1";
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
		assistantLlmUrl: process.env["CONSOLE_ASSISTANT_LLM_URL"] ?? null,
		assistantLlmModel: process.env["CONSOLE_ASSISTANT_LLM_MODEL"] ?? null,
		assistantLlmApiKey: process.env["CONSOLE_ASSISTANT_LLM_API_KEY"] ?? null,
	};
}
