import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

// This auto-approving provider is only started by the orb development service.
const port = Number(process.env.PORT ?? 8080);
const origin = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const issuer = `${origin}/realms/grove`;
const clientId = "grove-browser-development";
const clientSecret = "grove-browser-development-secret";
const ownerSubject = "operator-development";
const authorizationCodes = new Map();
const accessTokens = new Set();
const keys = await generateKeyPair("RS256");
const publicJwk = {
	...(await exportJWK(keys.publicKey)),
	alg: "RS256",
	kid: "grove-development",
	use: "sig",
};

const sendJson = (response, status, body) => {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json",
	});
	response.end(JSON.stringify(body));
};

const readForm = async (request) => {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 16_384) throw new Error("Request body too large");
	}
	return new URLSearchParams(body);
};

const redirectUriAllowed = (value) => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname.endsWith(".onamp.dev") &&
			url.pathname === "/api/auth/callback/grove-oidc"
		);
	} catch {
		return false;
	}
};

createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", issuer);
	if (url.pathname === "/") {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("Grove development OIDC provider\n");
		return;
	}

	if (url.pathname === "/realms/grove/.well-known/openid-configuration") {
		sendJson(response, 200, {
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			userinfo_endpoint: `${issuer}/userinfo`,
			jwks_uri: `${issuer}/jwks`,
			id_token_signing_alg_values_supported: ["RS256"],
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
			scopes_supported: ["openid", "profile", "email"],
		});
		return;
	}

	if (url.pathname === "/realms/grove/jwks") {
		sendJson(response, 200, { keys: [publicJwk] });
		return;
	}

	if (request.method === "GET" && url.pathname === "/realms/grove/authorize") {
		const redirectUri = url.searchParams.get("redirect_uri") ?? "";
		const state = url.searchParams.get("state") ?? "";
		const nonce = url.searchParams.get("nonce") ?? "";
		const codeChallenge = url.searchParams.get("code_challenge") ?? "";
		if (
			url.searchParams.get("client_id") !== clientId ||
			url.searchParams.get("response_type") !== "code" ||
			url.searchParams.get("code_challenge_method") !== "S256" ||
			!redirectUriAllowed(redirectUri) ||
			!state ||
			!nonce ||
			!codeChallenge
		) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		const code = randomBytes(24).toString("base64url");
		authorizationCodes.set(code, {
			codeChallenge,
			expiresAt: Date.now() + 60_000,
			nonce,
			redirectUri,
		});
		const callback = new URL(redirectUri);
		callback.searchParams.set("code", code);
		callback.searchParams.set("state", state);
		response.writeHead(302, { location: callback.href });
		response.end();
		return;
	}

	if (request.method === "POST" && url.pathname === "/realms/grove/token") {
		try {
			const form = await readForm(request);
			const code = form.get("code") ?? "";
			const authorization = authorizationCodes.get(code);
			authorizationCodes.delete(code);
			const basic = request.headers.authorization?.startsWith("Basic ")
				? Buffer.from(request.headers.authorization.slice(6), "base64").toString().split(":", 2)
				: [];
			const suppliedClientId = form.get("client_id") ?? basic[0];
			const suppliedClientSecret = form.get("client_secret") ?? basic[1];
			const verifier = form.get("code_verifier") ?? "";
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (
				form.get("grant_type") !== "authorization_code" ||
				suppliedClientId !== clientId ||
				suppliedClientSecret !== clientSecret ||
				!authorization ||
				authorization.expiresAt < Date.now() ||
				form.get("redirect_uri") !== authorization.redirectUri ||
				challenge !== authorization.codeChallenge
			) {
				sendJson(response, 400, { error: "invalid_grant" });
				return;
			}

			const accessToken = randomBytes(24).toString("base64url");
			accessTokens.add(accessToken);
			const idToken = await new SignJWT({
				email: "operator@grove.invalid",
				email_verified: true,
				name: "Grove Operator",
				nonce: authorization.nonce,
			})
				.setProtectedHeader({ alg: "RS256", kid: "grove-development" })
				.setIssuer(issuer)
				.setAudience(clientId)
				.setSubject(ownerSubject)
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(keys.privateKey);
			sendJson(response, 200, {
				access_token: accessToken,
				expires_in: 300,
				id_token: idToken,
				token_type: "Bearer",
			});
		} catch {
			sendJson(response, 400, { error: "invalid_request" });
		}
		return;
	}

	if (url.pathname === "/realms/grove/userinfo") {
		const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
		if (!bearer || !accessTokens.has(bearer)) {
			sendJson(response, 401, { error: "invalid_token" });
			return;
		}
		sendJson(response, 200, {
			email: "operator@grove.invalid",
			email_verified: true,
			name: "Grove Operator",
			sub: ownerSubject,
		});
		return;
	}

	sendJson(response, 404, { error: "not_found" });
}).listen(port, "0.0.0.0");
