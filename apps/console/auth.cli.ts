// Schema-only Better Auth config. Runtime configuration lives in src/lib/server/auth.ts; keep the
// user fields in lockstep and regenerate migrations with `pnpm auth:schema`.
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { Pool } from "pg";

export const auth = betterAuth({
	secret: process.env["BETTER_AUTH_SECRET"] ?? "schema-generation-placeholder-secret",
	baseURL: process.env["BETTER_AUTH_URL"] ?? "http://localhost:5173",
	database: new Pool({
		connectionString: process.env["DATABASE_URL"] ?? "postgres://localhost/console",
	}),
	account: { encryptOAuthTokens: true, storeAccountCookie: false },
	user: {
		additionalFields: {
			authentikUsername: { type: "string", required: true, input: false },
			authentikGroups: { type: "string", required: true, input: false },
			authentikSubject: { type: "string", required: true, input: false },
		},
	},
	plugins: [
		genericOAuth({
			config: [
				{
					providerId: "authentik",
					clientId: "schema",
					clientSecret: "schema",
					discoveryUrl: "https://authentik.invalid/.well-known/openid-configuration",
				},
			],
		}),
	],
});
