import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import { Pool } from "pg";

export interface BetterAuthSessionIdentity { readonly username: string; readonly groups: readonly string[]; readonly subject?: string; }
export interface BetterAuthSessionVerifier {
	readonly consoleOrigin?: string;
	getIdentity(headers: Parameters<typeof fromNodeHeaders>[0]): Promise<BetterAuthSessionIdentity | null>;
	close(): Promise<void>;
}
export interface BetterAuthSessionConfig { readonly databaseUrl: string; readonly baseUrl: string; readonly secret: string; }

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || codePoint === 0x7f;
	});
}

export function parseBetterAuthIdentity(user: Record<string, unknown>): BetterAuthSessionIdentity | null {
	const username = user["authentikUsername"];
	const encodedGroups = user["authentikGroups"];
	const subject = user["authentikSubject"];
	if (typeof username !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) return null;
	if (typeof subject !== "string" || subject.length === 0 || subject.length > 255 || hasControlCharacter(subject)) return null;
	if (typeof encodedGroups !== "string") return null;
	try {
		const groups = JSON.parse(encodedGroups) as unknown;
		if (!Array.isArray(groups) || groups.length === 0 || groups.length > 128 ||
			groups.some((group) => typeof group !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(group)) ||
			new Set(groups).size !== groups.length) return null;
		return { username, groups, subject };
	} catch { return null; }
}

export function createBetterAuthSessionVerifier(config: BetterAuthSessionConfig): BetterAuthSessionVerifier {
	const pool = new Pool({ connectionString: config.databaseUrl });
	const auth = betterAuth({
		appName: "Lab Console", baseURL: config.baseUrl, secret: config.secret, database: pool,
		account: { encryptOAuthTokens: true, storeAccountCookie: false },
		user: { additionalFields: {
			authentikUsername: { type: "string", required: true, input: false },
			authentikGroups: { type: "string", required: true, input: false },
			authentikSubject: { type: "string", required: true, input: false },
		} },
	});
	return {
		consoleOrigin: new URL(config.baseUrl).origin,
		async getIdentity(headers) {
			const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
			return session ? parseBetterAuthIdentity(session.user as unknown as Record<string, unknown>) : null;
		},
		async close() { await pool.end(); },
	};
}
