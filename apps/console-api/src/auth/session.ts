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
			return session
				? parseBetterAuthIdentity(session.user as unknown as Record<string, unknown>)
				: null;
		},
		async close() {
			await pool.end();
		},
	};
}
