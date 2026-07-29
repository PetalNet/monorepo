import { building, dev } from "$app/env";
import { getRequestEvent } from "$app/server";
import { createEffectQbAdapter } from "@petalnet/better-auth-effect-qb-adapter";
import { betterAuth } from "better-auth/minimal";
import { sveltekitCookies } from "better-auth/svelte-kit";

const required = (name: string) => {
	const value = process.env[name]?.trim();
	if (value) return value;
	if (building) return `build-placeholder-${name.toLowerCase()}`;
	throw new Error(`Missing required authentication setting: ${name}`);
};

const baseURL = process.env.BETTER_AUTH_URL?.trim() || undefined;
const secret =
	process.env.BETTER_AUTH_SECRET?.trim() ||
	(building || dev
		? "grove-development-secret-at-least-32-characters"
		: required("BETTER_AUTH_SECRET"));

const database = createEffectQbAdapter(required("DATABASE_URL"));

export const auth = betterAuth({
	appName: "Grove",
	...(baseURL ? { baseURL } : {}),
	secret,
	database,
	emailAndPassword: { enabled: true },
	plugins: [sveltekitCookies(getRequestEvent)],
});

export const disposeAuth = () => database.close();

if (import.meta.hot) import.meta.hot.dispose(disposeAuth);
