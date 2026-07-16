import { building } from "$app/env";
import { getRequestEvent } from "$app/server";
import { createEffectQbAdapter } from "@petalnet/better-auth-effect-qb-adapter";
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";

import { initializeAdminBootstrap } from "./bootstrap";

const required = (name: string) => {
	const value = process.env[name];
	if (value) return value;
	if (building) return `build-placeholder-${name.toLowerCase()}`;
	throw new Error(`Missing required authentication setting: ${name}`);
};

const baseURL =
	process.env.BETTER_AUTH_URL ?? (building ? "http://localhost:5173" : required("BETTER_AUTH_URL"));
const issuer =
	process.env.OIDC_ISSUER ?? (building ? "https://oidc.invalid" : required("OIDC_ISSUER"));
const databaseUrl =
	process.env.DATABASE_URL ??
	(building ? "postgresql://build.invalid/console" : required("DATABASE_URL"));

export const auth = betterAuth({
	appName: "Lab Console",
	baseURL,
	secret: required("BETTER_AUTH_SECRET"),
	database: createEffectQbAdapter(databaseUrl),
	account: { encryptOAuthTokens: true, storeAccountCookie: false },
	trustedOrigins: [new URL(baseURL).origin],
	advanced: {
		useSecureCookies: new URL(baseURL).protocol === "https:",
		cookiePrefix: new URL(baseURL).protocol === "https:" ? "__Host-" : "console",
		defaultCookieAttributes: {
			secure: new URL(baseURL).protocol === "https:",
			httpOnly: true,
			sameSite: "lax",
			path: "/",
		},
	},
	session: { expiresIn: 5 * 60, updateAge: 0 },
	disabledPaths: ["/sign-up/email", "/update-user"],
	user: {
		additionalFields: {
			tier: { type: "string", required: true, defaultValue: "viewer", input: false },
		},
	},
	plugins: [
		genericOAuth({
			config: [
				{
					providerId: "oidc",
					clientId: required("OIDC_CLIENT_ID"),
					clientSecret: required("OIDC_CLIENT_SECRET"),
					discoveryUrl: `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
					redirectURI: process.env.OIDC_REDIRECT_URI,
					pkce: true,
					scopes: (process.env.OIDC_SCOPES ?? "openid,profile,email")
						.split(",")
						.map((scope) => scope.trim())
						.filter(Boolean),
				},
			],
		}),
		sveltekitCookies(getRequestEvent),
	],
});

export const adminBootstrapReady = building ? Promise.resolve() : initializeAdminBootstrap(auth);
