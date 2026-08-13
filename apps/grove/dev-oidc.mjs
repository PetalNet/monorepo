import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

// This auto-approving provider is only started by the orb development service.
const port = Number(process.env.PORT ?? 8080);
const origin = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const issuer = `${origin}/realms/grove`;
const mcpIssuer = `${origin}/realms/grove-mcp`;
const clientId = "grove-browser-development";
const clientSecret = "grove-browser-development-secret";
const mcpClientSecret = process.env.GROVE_MCP_CLIENT_SECRET ?? "grove-mcp-development-only-secret";
const mcpScopes = ["grove:mcp", "grove:agent:enroll"];
const ownerSubject = "operator-development";
const authorizationCodes = new Map();
const accessTokens = new Set();
const keys = await generateKeyPair("RS256");
const keyId = `grove-development-${randomBytes(12).toString("base64url")}`;
const publicJwk = {
	...(await exportJWK(keys.publicKey)),
	alg: "RS256",
	kid: keyId,
	use: "sig",
};

const sendJson = (response, status, body, headers = {}) => {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json",
		...headers,
	});
	response.end(JSON.stringify(body));
};

const canonicalMcpResource = (value) => {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/mcp"
	)
		throw new Error("Invalid Grove MCP resource URL");
	return url.href;
};

const groveMcpResource = async () => {
	if (process.env.GROVE_MCP_RESOURCE) return canonicalMcpResource(process.env.GROVE_MCP_RESOURCE);
	const manifest = JSON.parse(
		await readFile(process.env.GROVE_MCP_PORTAL_MANIFEST ?? ".amp/portals/grove.json", "utf8"),
	);
	const portal = manifest?.links?.[0]?.url;
	if (typeof portal !== "string") throw new Error("Grove portal URL is unavailable");
	return canonicalMcpResource(new URL("mcp", portal).href);
};

const mcpMetadata = {
	issuer: mcpIssuer,
	authorization_endpoint: `${mcpIssuer}/authorize`,
	token_endpoint: `${mcpIssuer}/token`,
	jwks_uri: `${mcpIssuer}/jwks`,
	grant_types_supported: ["client_credentials"],
	token_endpoint_auth_methods_supported: ["client_secret_basic"],
	scopes_supported: mcpScopes,
	response_types_supported: [],
	resource_indicators_supported: true,
};

const basicCredentials = (authorization) => {
	const encoded = authorization?.match(/^Basic ([A-Za-z\d+/]+={0,2})$/i)?.[1];
	if (!encoded) return undefined;
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	// The official MCP client sends the client ID verbatim, so split from the fixed shared secret
	// at the final colon to permit URL-shaped Agent subjects.
	const separator = decoded.lastIndexOf(":");
	if (separator < 1) return undefined;
	return {
		clientId: decoded.slice(0, separator),
		clientSecret: decoded.slice(separator + 1),
	};
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

	if (
		[
			"/.well-known/oauth-authorization-server/realms/grove-mcp",
			"/.well-known/openid-configuration/realms/grove-mcp",
			"/realms/grove-mcp/.well-known/openid-configuration",
		].includes(url.pathname)
	) {
		sendJson(response, 200, mcpMetadata);
		return;
	}

	if (["/realms/grove/jwks", "/realms/grove-mcp/jwks"].includes(url.pathname)) {
		sendJson(response, 200, { keys: [publicJwk] });
		return;
	}

	if (url.pathname === "/realms/grove-mcp/authorize") {
		sendJson(response, 400, { error: "unsupported_response_type" });
		return;
	}

	if (request.method === "POST" && url.pathname === "/realms/grove-mcp/token") {
		try {
			const credentials = basicCredentials(request.headers.authorization);
			if (!credentials || credentials.clientSecret !== mcpClientSecret) {
				sendJson(response, 401, { error: "invalid_client" }, { "www-authenticate": "Basic" });
				return;
			}
			const form = await readForm(request);
			if (form.get("grant_type") !== "client_credentials") {
				sendJson(response, 400, { error: "unsupported_grant_type" });
				return;
			}
			const resource = await groveMcpResource();
			if (form.get("resource") !== resource) {
				sendJson(response, 400, { error: "invalid_target" });
				return;
			}
			const scopes = [...new Set((form.get("scope") ?? "").split(/\s+/).filter(Boolean))];
			if (scopes.some((scope) => !mcpScopes.includes(scope))) {
				sendJson(response, 400, { error: "invalid_scope" });
				return;
			}
			const now = Math.floor(Date.now() / 1000);
			const accessToken = await new SignJWT({
				client_id: credentials.clientId,
				scope: scopes.join(" "),
			})
				.setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
				.setIssuer(mcpIssuer)
				.setAudience(resource)
				.setSubject(credentials.clientId)
				.setIssuedAt(now)
				.setExpirationTime(now + 300)
				.sign(keys.privateKey);
			sendJson(response, 200, {
				access_token: accessToken,
				expires_in: 300,
				scope: scopes.join(" "),
				token_type: "Bearer",
			});
		} catch {
			sendJson(response, 400, { error: "invalid_request" });
		}
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
				.setProtectedHeader({ alg: "RS256", kid: keyId })
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
}).listen(port, "0.0.0.0", () => {
	console.log(`[grove-oidc] listening at ${origin}`);
});
