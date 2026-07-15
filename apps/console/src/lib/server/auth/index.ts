import { building } from "$app/env";
import { getRequestEvent } from "$app/server";
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { createEffectQbAdapter } from "./adapter";
import { authentikProfileUser, authentikUserFields } from "./authentik";

const required = (name: string) => {
	const value = process.env[name];
	if (value) return value;
	if (building) return `build-placeholder-${name.toLowerCase()}`;
	throw new Error(`Missing required authentication setting: ${name}`);
};

const baseURL = process.env.BETTER_AUTH_URL ?? (building ? "http://localhost:5173" : required("BETTER_AUTH_URL"));
const issuer = process.env.AUTHENTIK_OIDC_ISSUER ?? (building ? "https://authentik.invalid/application/o/console/" : required("AUTHENTIK_OIDC_ISSUER"));
const databaseUrl = process.env.DATABASE_URL ?? (building ? "postgresql://build.invalid/console" : required("DATABASE_URL"));

export const auth = betterAuth({
	appName: "Lab Console",
	baseURL,
	secret: required("BETTER_AUTH_SECRET"),
	database: createEffectQbAdapter(databaseUrl),
	account: { encryptOAuthTokens: true, storeAccountCookie: false },
	trustedOrigins: [new URL(baseURL).origin],
	advanced: {
		useSecureCookies: false,
		cookiePrefix: new URL(baseURL).protocol === "https:" ? "__Host-console" : "console",
		defaultCookieAttributes: {
			secure: new URL(baseURL).protocol === "https:",
			httpOnly: true,
			sameSite: "lax",
			path: "/",
		},
	},
	session: { expiresIn: 5 * 60, updateAge: 0 },
	disabledPaths: ["/sign-up/email", "/update-user"],
	user: { additionalFields: authentikUserFields },
	plugins: [
		genericOAuth({
			config: [
				{
					providerId: "authentik",
					clientId: required("AUTHENTIK_OIDC_CLIENT_ID"),
					clientSecret: required("AUTHENTIK_OIDC_CLIENT_SECRET"),
					discoveryUrl: `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
					issuer,
					requireIssuerValidation: false,
					pkce: true,
					scopes: ["openid", "profile", "email", "groups"],
					overrideUserInfo: true,
					mapProfileToUser: (profile) => authentikProfileUser(profile) as never,
				},
			],
		}),
		sveltekitCookies(getRequestEvent),
	],
});
