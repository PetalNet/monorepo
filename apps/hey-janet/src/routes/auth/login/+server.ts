import { createHash, randomBytes } from "node:crypto";

import { error, redirect } from "@sveltejs/kit";

import { discovery } from "#lib/server/oidc.ts";
import { sign } from "#lib/server/security.ts";

import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	const client = process.env.OIDC_CLIENT_ID;
	if (!client)
		error(503, "PetalNet sign-in is not configured. You can still record without an account.");
	const config = await discovery();
	const state = randomBytes(32).toString("base64url"),
		nonce = randomBytes(32).toString("base64url"),
		verifier = randomBytes(32).toString("base64url");
	event.cookies.set("booth-oidc", await sign({ state, nonce, verifier }, "10m"), {
		path: "/",
		httpOnly: true,
		secure: event.url.protocol === "https:",
		sameSite: "lax",
		maxAge: 600,
	});
	const url = new URL(config.authorization_endpoint);
	url.search = new URLSearchParams({
		client_id: client,
		response_type: "code",
		redirect_uri: `${event.url.origin}/auth/callback`,
		scope: "openid profile",
		state,
		nonce,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	redirect(303, url.toString(), { external: [url.origin] });
};
