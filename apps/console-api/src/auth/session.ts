import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import { Pool } from "pg";

import { parseBetterAuthIdentity, type BetterAuthSessionIdentity } from "./session-identity.ts";
export type { BetterAuthSessionIdentity } from "./session-identity.ts";
export interface BetterAuthSessionVerifier {
	readonly consoleOrigin?: string;
	getIdentity(
		headers: Parameters<typeof fromNodeHeaders>[0],
	): Promise<BetterAuthSessionIdentity | null>;
	getIdentityBySessionId(sessionId: string): Promise<BetterAuthSessionIdentity | null>;
	close(): Promise<void>;
}
export interface BetterAuthSessionConfig {
	readonly databaseUrl: string;
	readonly baseUrl: string;
	readonly secret: string;
}

export function createBetterAuthSessionVerifier(
	config: BetterAuthSessionConfig,
): BetterAuthSessionVerifier {
	const pool = new Pool({ connectionString: config.databaseUrl });
	const auth = betterAuth({
		appName: "Lab Console",
		baseURL: config.baseUrl,
		secret: config.secret,
		database: pool,
		account: { encryptOAuthTokens: true, storeAccountCookie: false },
		trustedOrigins: [new URL(config.baseUrl).origin],
		advanced: {
			useSecureCookies: false,
			cookiePrefix: new URL(config.baseUrl).protocol === "https:" ? "__Host-console" : "console",
			defaultCookieAttributes: {
				secure: new URL(config.baseUrl).protocol === "https:",
				httpOnly: true,
				sameSite: "lax",
				path: "/",
			},
		},
		session: { expiresIn: 5 * 60, updateAge: 0 },
		user: {
			additionalFields: {
				authentikUsername: { type: "string", required: true, input: false },
				authentikGroups: { type: "string", required: true, input: false },
				authentikSubject: { type: "string", required: true, input: false },
			},
		},
	});
	return {
		consoleOrigin: new URL(config.baseUrl).origin,
		async getIdentity(headers) {
			const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
			if (!session) return null;
			if (Date.now() - new Date(session.session.createdAt).getTime() > 5 * 60_000) return null;
			const identity = parseBetterAuthIdentity(session.user as unknown as Record<string, unknown>);
			return identity ? { ...identity, sessionId: session.session.id } : null;
		},
		async getIdentityBySessionId(sessionId) {
			if (!/^[A-Za-z0-9_-]{1,255}$/.test(sessionId)) return null;
			const result = await pool.query<{ user: Record<string, unknown> }>(
				`select row_to_json(u) as user from session s join "user" u on u.id = s."userId"
				 where s.id = $1 and s."expiresAt" > now()
				   and s."createdAt" > now() - interval '5 minutes'`,
				[sessionId],
			);
			const identity = result.rows[0]?.user ? parseBetterAuthIdentity(result.rows[0].user) : null;
			return identity ? { ...identity, sessionId } : null;
		},
		async close() {
			await pool.end();
		},
	};
}
