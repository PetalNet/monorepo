import { building } from "$app/environment";
import { getRequestEvent } from "$app/server";
import { env } from "$env/dynamic/private";
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { Pool } from "pg";

const AUTHENTIK_PROVIDER_ID = "authentik";

function required(name: string): string {
	const value = env[name];
	if (value) return value;
	if (building) return `build-placeholder-${name.toLowerCase()}`;
	throw new Error(`missing required auth env ${name}`);
}

const baseURL =
	env.BETTER_AUTH_URL ?? (building ? "http://localhost:5173" : required("BETTER_AUTH_URL"));
const issuer =
	env.AUTHENTIK_OIDC_ISSUER ??
	(building
		? "https://authentik.invalid/application/o/console/"
		: required("AUTHENTIK_OIDC_ISSUER"));
export const auth = betterAuth({
	appName: "Lab Console",
	baseURL,
	secret: required("BETTER_AUTH_SECRET"),
	database: new Pool({
		connectionString:
			env.DATABASE_URL ??
			(building ? "postgres://build.invalid/console" : required("DATABASE_URL")),
	}),
	account: { encryptOAuthTokens: true, storeAccountCookie: false },
	trustedOrigins: [new URL(baseURL).origin],
	advanced: {
		useSecureCookies: new URL(baseURL).protocol === "https:",
		cookiePrefix: "__Host-console",
	},
	session: { expiresIn: 5 * 60, updateAge: 0 },
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
					providerId: AUTHENTIK_PROVIDER_ID,
					clientId: required("AUTHENTIK_OIDC_CLIENT_ID"),
					clientSecret: required("AUTHENTIK_OIDC_CLIENT_SECRET"),
					discoveryUrl: `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
					issuer,
					requireIssuerValidation: true,
					pkce: true,
					scopes: ["openid", "profile", "email", "groups"],
					overrideUserInfo: true,
					mapProfileToUser(profile) {
						const username =
							typeof profile.preferred_username === "string" ? profile.preferred_username : "";
						const groups = Array.isArray(profile.groups)
							? profile.groups.filter((group): group is string => typeof group === "string")
							: [];
						return {
							name: typeof profile.name === "string" ? profile.name : username,
							email: typeof profile.email === "string" ? profile.email : "",
							authentikUsername: username,
							authentikGroups: JSON.stringify(groups),
							authentikSubject: typeof profile.sub === "string" ? profile.sub : "",
						} as never;
					},
				},
			],
		}),
		sveltekitCookies(getRequestEvent),
	],
});

export const authConfigured = Boolean(
	env.BETTER_AUTH_SECRET &&
	env.BETTER_AUTH_URL &&
	env.DATABASE_URL &&
	env.AUTHENTIK_OIDC_ISSUER &&
	env.AUTHENTIK_OIDC_CLIENT_ID &&
	env.AUTHENTIK_OIDC_CLIENT_SECRET,
);
