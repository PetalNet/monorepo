import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	type KeyObject,
} from "node:crypto";
import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
	Cause,
	Clock,
	Config,
	Console,
	Data,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
} from "effect";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SignJWT } from "jose";

// This auto-approving provider is only started by the orb development service.
const clientId = "grove-browser-development";
const clientSecret = "grove-browser-development-secret";
const mcpScopes = ["grove:mcp", "grove:agent:enroll"];
const ownerSubject = "operator-development";

class InvalidRequest extends Data.TaggedError("InvalidRequest") {}

class InvalidSigningKey extends Data.TaggedError("InvalidSigningKey")<{ readonly path: string }> {
	override get message() {
		return `Grove development OIDC signing key is invalid at ${this.path}; stop grove-oidc and remove the corrupted file, then rerun .agents/ensure-grove`;
	}
}

const SigningKeyDocument = Schema.fromJsonString(
	Schema.Struct({
		version: Schema.Literal(1),
		privateKeyPkcs8: Schema.String.check(Schema.isPattern(/BEGIN PRIVATE KEY/u)),
	}),
);
const PortalManifest = Schema.fromJsonString(
	Schema.Struct({ links: Schema.Array(Schema.Unknown) }),
);
const PortalLink = Schema.Struct({ url: Schema.String });

const keyIdFor = (publicKey: KeyObject) =>
	`grove-development-${createHash("sha256")
		.update(publicKey.export({ type: "spki", format: "der" }))
		.digest("base64url")
		.slice(0, 24)}`;

const readSigningKey = Effect.fnUntraced(function* (signingKeyPath: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* Effect.gen(function* () {
		yield* fs.chmod(signingKeyPath, 0o600);
		const stored = yield* Schema.decodeEffect(SigningKeyDocument)(
			yield* fs.readFileString(signingKeyPath),
		);
		return yield* Effect.try({
			try: () => createPrivateKey(stored.privateKeyPkcs8),
			catch: () => new InvalidSigningKey({ path: signingKeyPath }),
		});
	}).pipe(
		Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
		Effect.mapError(() => new InvalidSigningKey({ path: signingKeyPath })),
	);
});

const createSigningKey = Effect.fnUntraced(function* (signingKeyPath: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* fs.makeDirectory(path.dirname(signingKeyPath), { recursive: true, mode: 0o700 });
	yield* fs.chmod(path.dirname(signingKeyPath), 0o700);
	const generated = yield* Effect.sync(() => generateKeyPairSync("rsa", { modulusLength: 2048 }));
	const privateKeyPkcs8 = generated.privateKey.export({ type: "pkcs8", format: "pem" });
	return yield* fs
		.writeFileString(
			signingKeyPath,
			`${yield* Schema.encodeEffect(SigningKeyDocument)({ version: 1, privateKeyPkcs8 })}\n`,
			{ flag: "wx", mode: 0o600 },
		)
		.pipe(
			Effect.as(generated.privateKey),
			Effect.catchReason("PlatformError", "AlreadyExists", () =>
				readSigningKey(signingKeyPath).pipe(
					Effect.filterOrFail(
						(existing) => existing !== undefined,
						() => new InvalidSigningKey({ path: signingKeyPath }),
					),
				),
			),
		);
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	HttpServerResponse.jsonUnsafe(body, {
		status,
		headers: { "cache-control": "no-store", ...headers },
	});

const canonicalMcpResource = Effect.fnUntraced(function* (value: string) {
	const url = yield* Effect.try({
		try: () => new URL(value),
		catch: () => new InvalidRequest(),
	});
	if (
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/mcp"
	) {
		return yield* new InvalidRequest();
	}
	return url.href;
});

const basicCredentials = (authorization: string | undefined) => {
	const encoded = authorization?.match(/^Basic ([A-Za-z\d+/]+={0,2})$/i)?.[1];
	if (!encoded) {
		return undefined;
	}
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	// The official MCP client sends the client ID verbatim, so split from the fixed shared secret
	// at the final colon to permit URL-shaped Agent subjects.
	const separator = decoded.lastIndexOf(":");
	if (separator < 1) {
		return undefined;
	}
	return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
};

const readForm = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
	// The default request stream destroys the socket before an oversized-body response can be sent.
	const body = yield* NodeStream.fromReadable<Uint8Array, InvalidRequest>({
		evaluate: () => NodeHttpServerRequest.toIncomingMessage(request),
		onError: () => new InvalidRequest(),
		closeOnDone: false,
	}).pipe(
		Stream.decodeText(),
		Stream.runFoldEffect(
			() => "",
			(accumulated, chunk) => {
				const text = accumulated + chunk;
				return text.length > 16_384 ? Effect.fail(new InvalidRequest()) : Effect.succeed(text);
			},
		),
	);
	return new URLSearchParams(body);
});

const redirectUriAllowed = (value: string) => {
	const url = URL.parse(value);
	return (
		url !== null &&
		url.protocol === "https:" &&
		url.hostname.endsWith(".onamp.dev") &&
		url.pathname === "/api/auth/callback/grove-oidc"
	);
};

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const port = yield* Config.Number("PORT").pipe(Config.withDefault(8080));
	const origin = (yield* Config.String("PUBLIC_URL").pipe(
		Config.withDefault(`http://localhost:${String(port)}`),
	)).replace(/\/$/, "");
	const issuer = `${origin}/realms/grove`;
	const mcpIssuer = `${origin}/realms/grove-mcp`;
	const mcpClientSecret = yield* Config.String("GROVE_MCP_CLIENT_SECRET").pipe(
		Config.withDefault("grove-mcp-development-only-secret"),
	);
	const configuredResource = yield* Config.String("GROVE_MCP_RESOURCE").pipe(
		Config.withDefault(""),
	);
	const portalManifestPath = yield* Config.String("GROVE_MCP_PORTAL_MANIFEST").pipe(
		Config.withDefault(".amp/portals/grove.json"),
	);
	const signingKeyPath = path.resolve(
		yield* Config.String("GROVE_OIDC_SIGNING_KEY_PATH").pipe(
			Config.withDefault(".amp/state/grove-oidc-signing-key.json"),
		),
	);
	const privateKey =
		(yield* readSigningKey(signingKeyPath)) ?? (yield* createSigningKey(signingKeyPath));
	const publicKey = createPublicKey(privateKey);
	const keyId = keyIdFor(publicKey);
	const publicJwk = {
		...publicKey.export({ format: "jwk" }),
		alg: "RS256",
		kid: keyId,
		use: "sig",
	};
	const authorizationCodes = new Map<
		string,
		{ codeChallenge: string; expiresAt: number; nonce: string; redirectUri: string }
	>();
	const accessTokens = new Set<string>();
	const groveMcpResource = Effect.gen(function* () {
		if (configuredResource) {
			return yield* canonicalMcpResource(configuredResource);
		}
		const manifest = yield* Schema.decodeEffect(PortalManifest)(
			yield* fs.readFileString(portalManifestPath),
		);
		const portal = yield* Schema.decodeUnknownEffect(PortalLink)(manifest.links[0]);
		const url = yield* Effect.try({
			try: () => new URL("mcp", portal.url),
			catch: () => new InvalidRequest(),
		});
		return yield* canonicalMcpResource(url.href);
	});
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
	const mcpToken = Effect.fnUntraced(
		function* (request: HttpServerRequest.HttpServerRequest) {
			const credentials = basicCredentials(
				Option.getOrUndefined(Headers.get(request.headers, "authorization")),
			);
			if (credentials?.clientSecret !== mcpClientSecret) {
				return json(401, { error: "invalid_client" }, { "www-authenticate": "Basic" });
			}
			const form = yield* readForm(request);
			if (form.get("grant_type") !== "client_credentials") {
				return json(400, { error: "unsupported_grant_type" });
			}
			const resource = yield* groveMcpResource;
			if (form.get("resource") !== resource) {
				return json(400, { error: "invalid_target" });
			}
			const scopes = [...new Set((form.get("scope") ?? "").split(/\s+/).filter(Boolean))];
			if (scopes.some((scope) => !mcpScopes.includes(scope))) {
				return json(400, { error: "invalid_scope" });
			}
			const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
			const accessToken = yield* Effect.tryPromise({
				try: () =>
					new SignJWT({ client_id: credentials.clientId, scope: scopes.join(" ") })
						.setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
						.setIssuer(mcpIssuer)
						.setAudience(resource)
						.setSubject(credentials.clientId)
						.setIssuedAt(now)
						.setExpirationTime(now + 300)
						.sign(privateKey),
				catch: () => new InvalidRequest(),
			});
			return json(200, {
				access_token: accessToken,
				expires_in: 300,
				scope: scopes.join(" "),
				token_type: "Bearer",
			});
		},
		Effect.orElseSucceed(() => json(400, { error: "invalid_request" }, { connection: "close" })),
	);
	const browserToken = Effect.fnUntraced(
		function* (request: HttpServerRequest.HttpServerRequest) {
			const form = yield* readForm(request);
			const code = form.get("code") ?? "";
			const authorization = authorizationCodes.get(code);
			authorizationCodes.delete(code);
			const clientAuthorization = Option.getOrUndefined(
				Headers.get(request.headers, "authorization"),
			);
			const basic = clientAuthorization?.startsWith("Basic ")
				? Buffer.from(clientAuthorization.slice(6), "base64").toString().split(":", 2)
				: [];
			const verifier = form.get("code_verifier") ?? "";
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (
				form.get("grant_type") !== "authorization_code" ||
				(form.get("client_id") ?? basic[0]) !== clientId ||
				(form.get("client_secret") ?? basic[1]) !== clientSecret ||
				!authorization ||
				authorization.expiresAt < (yield* Clock.currentTimeMillis) ||
				form.get("redirect_uri") !== authorization.redirectUri ||
				challenge !== authorization.codeChallenge
			) {
				return json(400, { error: "invalid_grant" });
			}
			const accessToken = yield* Effect.sync(() => randomBytes(24).toString("base64url"));
			accessTokens.add(accessToken);
			const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
			const idToken = yield* Effect.tryPromise({
				try: () =>
					new SignJWT({
						email: "operator@grove.invalid",
						email_verified: true,
						name: "Grove Operator",
						nonce: authorization.nonce,
					})
						.setProtectedHeader({ alg: "RS256", kid: keyId })
						.setIssuer(issuer)
						.setAudience(clientId)
						.setSubject(ownerSubject)
						.setIssuedAt(now)
						.setExpirationTime(now + 300)
						.sign(privateKey),
				catch: () => new InvalidRequest(),
			});
			return json(200, {
				access_token: accessToken,
				expires_in: 300,
				id_token: idToken,
				token_type: "Bearer",
			});
		},
		Effect.orElseSucceed(() => json(400, { error: "invalid_request" }, { connection: "close" })),
	);
	const handleRequest = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = yield* Effect.try({
			try: () => new URL(request.url, issuer),
			catch: () => new InvalidRequest(),
		});
		if (url.pathname === "/") {
			return HttpServerResponse.text("Grove development OIDC provider\n");
		}
		if (url.pathname === "/realms/grove/.well-known/openid-configuration") {
			return json(200, {
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
		}
		if (
			[
				"/.well-known/oauth-authorization-server/realms/grove-mcp",
				"/.well-known/openid-configuration/realms/grove-mcp",
				"/realms/grove-mcp/.well-known/openid-configuration",
			].includes(url.pathname)
		) {
			return json(200, mcpMetadata);
		}
		if (["/realms/grove/jwks", "/realms/grove-mcp/jwks"].includes(url.pathname)) {
			return json(200, { keys: [publicJwk] });
		}
		if (url.pathname === "/realms/grove-mcp/authorize") {
			return json(400, { error: "unsupported_response_type" });
		}
		if (request.method === "POST" && url.pathname === "/realms/grove-mcp/token") {
			return yield* mcpToken(request);
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
				return json(400, { error: "invalid_request" });
			}
			const code = yield* Effect.sync(() => randomBytes(24).toString("base64url"));
			authorizationCodes.set(code, {
				codeChallenge,
				expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
				nonce,
				redirectUri,
			});
			const callback = new URL(redirectUri);
			callback.searchParams.set("code", code);
			callback.searchParams.set("state", state);
			return HttpServerResponse.redirect(callback, { status: 302 });
		}
		if (request.method === "POST" && url.pathname === "/realms/grove/token") {
			return yield* browserToken(request);
		}
		if (url.pathname === "/realms/grove/userinfo") {
			const bearer = /^Bearer (.+)$/.exec(
				Option.getOrElse(Headers.get(request.headers, "authorization"), () => ""),
			)?.[1];
			if (!bearer || !accessTokens.has(bearer)) {
				return json(401, { error: "invalid_token" });
			}
			return json(200, {
				email: "operator@grove.invalid",
				email_verified: true,
				name: "Grove Operator",
				sub: ownerSubject,
			});
		}
		return json(404, { error: "not_found" });
	}).pipe(
		Effect.catchTag("InvalidRequest", () =>
			Effect.succeed(json(400, { error: "invalid_request" })),
		),
	);
	const server = yield* NodeHttpServer.make(createServer, { port, host: "0.0.0.0" });
	yield* server.serve(handleRequest);
	yield* Effect.logInfo(`[grove-oidc] listening at ${origin}`);
	return yield* Effect.never;
});

NodeRuntime.runMain(
	program.pipe(
		Effect.scoped,
		Effect.provide(NodeServices.layer),
		Effect.tapCause((cause) => Console.error(Cause.pretty(cause))),
	),
	{ disableErrorReporting: true },
);
