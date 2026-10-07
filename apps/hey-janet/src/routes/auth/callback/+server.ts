import { error, redirect } from "@sveltejs/kit";
import { z } from "zod";

import { claims, discovery } from "#lib/server/oidc.ts";
import { sign, verify } from "#lib/server/security.ts";

import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	const cookie = event.cookies.get("booth-oidc");
	event.cookies.delete("booth-oidc", { path: "/" });
	try {
		const pending = await verify(cookie ?? "");
		const code = event.url.searchParams.get("code");
		if (
			!code ||
			pending.state !== event.url.searchParams.get("state") ||
			typeof pending.verifier !== "string" ||
			typeof pending.nonce !== "string"
		)
			throw new Error("Invalid callback");
		const config = await discovery();
		const response = await fetch(config.token_endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: process.env.OIDC_CLIENT_ID ?? "",
				client_secret: process.env.OIDC_CLIENT_SECRET ?? "",
				redirect_uri: `${event.url.origin}/auth/callback`,
				code,
				code_verifier: pending.verifier,
			}),
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) throw new Error("Token exchange failed");
		const tokens = z.object({ id_token: z.string() }).parse(await response.json());
		const p = await claims(tokens.id_token, config.jwks_uri, pending.nonce);
		const groups = z.array(z.string()).safeParse(p.groups);
		const admin =
			(!!process.env.BOOTH_ADMIN_SUB && p.sub === process.env.BOOTH_ADMIN_SUB) ||
			(!!process.env.BOOTH_ADMIN_GROUP &&
				groups.success &&
				groups.data.includes(process.env.BOOTH_ADMIN_GROUP));
		event.cookies.set(
			"booth-auth",
			await sign(
				{ sub: p.sub, name: typeof p.given_name === "string" ? p.given_name : "", admin },
				"1h",
			),
			{
				path: "/",
				httpOnly: true,
				secure: event.url.protocol === "https:",
				sameSite: "lax",
				maxAge: 3600,
			},
		);
	} catch {
		error(
			400,
			"Sign-in could not be completed. Return to the booth to try again or record without signing in.",
		);
	}
	redirect(303, "/");
};
