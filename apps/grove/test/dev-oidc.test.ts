import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const mcpResource = "https://grove.example/mcp";
const mcpSecret = "grove-mcp-test-development-secret";
const providerPath = fileURLToPath(new URL("../dev-oidc.mjs", import.meta.url));

interface DevelopmentJwks {
	readonly keys: (JsonWebKey & { readonly kid?: string })[];
}

const availablePort = async () => {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to reserve a test port");
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
	return address.port;
};

const waitForProvider = async (origin: string, child: ChildProcess) => {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (child.exitCode !== null)
			throw new Error(`Development OIDC provider exited ${String(child.exitCode)}`);
		try {
			// oxlint-disable-next-line no-await-in-loop
			const response = await fetch(origin);
			if (response.ok) return;
		} catch {
			// The child may not have bound its port yet.
		}
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Development OIDC provider did not become ready");
};

const keyIdAt = async (origin: string) => {
	const response = await fetch(`${origin}/realms/grove-mcp/jwks`);
	if (!response.ok) throw new Error(`Development JWKS returned HTTP ${String(response.status)}`);
	const jwks = (await response.json()) as DevelopmentJwks;
	const keyId = jwks.keys[0]?.kid;
	if (!keyId) throw new Error("Development JWKS did not publish a key ID");
	return keyId;
};

describe("Grove development MCP authorization server", () => {
	let child: ChildProcess;
	let origin: string;
	let issuer: string;
	let stderr = "";
	let signingKeyPath: string;
	let temporaryDirectory: string;

	beforeAll(async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "grove-dev-oidc-"));
		signingKeyPath = join(temporaryDirectory, "signing-key.json");
		const port = await availablePort();
		origin = `http://127.0.0.1:${String(port)}`;
		issuer = `${origin}/realms/grove-mcp`;
		child = spawn(process.execPath, [providerPath], {
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				PORT: String(port),
				PUBLIC_URL: origin,
				GROVE_MCP_CLIENT_SECRET: mcpSecret,
				GROVE_MCP_RESOURCE: mcpResource,
				GROVE_OIDC_SIGNING_KEY_PATH: signingKeyPath,
			},
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		try {
			await waitForProvider(origin, child);
		} catch (error) {
			throw new Error(`${String(error)}\n${stderr}`, { cause: error });
		}
	}, 10_000);

	afterAll(async () => {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		await rm(temporaryDirectory, { recursive: true });
	});

	it("publishes RFC 8414, OIDC fallback, and public signing metadata", async () => {
		const paths = [
			"/.well-known/oauth-authorization-server/realms/grove-mcp",
			"/.well-known/openid-configuration/realms/grove-mcp",
			"/realms/grove-mcp/.well-known/openid-configuration",
		];
		for (const path of paths) {
			// oxlint-disable-next-line no-await-in-loop
			const response = await fetch(`${origin}${path}`);
			expect(response.status).toBe(200);
			// oxlint-disable-next-line no-await-in-loop
			await expect(response.json()).resolves.toMatchObject({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				grant_types_supported: ["client_credentials"],
				token_endpoint_auth_methods_supported: ["client_secret_basic"],
				scopes_supported: ["grove:mcp", "grove:agent:enroll"],
			});
		}

		const jwks = await fetch(`${issuer}/jwks`);
		expect(jwks.status).toBe(200);
		expect(await jwks.json()).toMatchObject({
			keys: [
				{
					alg: "RS256",
					kid: expect.stringMatching(/^grove-development-[A-Za-z\d_-]+$/) as unknown,
					kty: "RSA",
					use: "sig",
				},
			],
		});
	});

	it("persists a secure signing key with a stable key ID across provider processes", async () => {
		const firstKeyId = await keyIdAt(origin);
		const firstJwks = (await (
			await fetch(`${origin}/realms/grove-mcp/jwks`)
		).json()) as DevelopmentJwks;
		const signingKey = await open(signingKeyPath, "r");
		try {
			expect((await signingKey.stat()).mode & 0o777).toBe(0o600);
			expect(await signingKey.readFile("utf8")).not.toContain(firstKeyId);
		} finally {
			await signingKey.close();
		}
		const secondPort = await availablePort();
		const secondOrigin = `http://127.0.0.1:${String(secondPort)}`;
		const second = spawn(process.execPath, [providerPath], {
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				PORT: String(secondPort),
				PUBLIC_URL: secondOrigin,
				GROVE_MCP_CLIENT_SECRET: mcpSecret,
				GROVE_MCP_RESOURCE: mcpResource,
				GROVE_OIDC_SIGNING_KEY_PATH: signingKeyPath,
			},
		});
		try {
			await waitForProvider(secondOrigin, second);
			expect(await keyIdAt(secondOrigin)).toBe(firstKeyId);
			const clientId = "restart-verification-agent";
			const tokenResponse = await fetch(`${secondOrigin}/realms/grove-mcp/token`, {
				method: "POST",
				headers: {
					authorization: `Basic ${Buffer.from(`${clientId}:${mcpSecret}`).toString("base64")}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "client_credentials",
					resource: mcpResource,
					scope: "grove:mcp grove:agent:enroll",
				}),
			});
			expect(tokenResponse.status).toBe(200);
			const issued = (await tokenResponse.json()) as { access_token: string };
			await expect(
				jwtVerify(issued.access_token, createLocalJWKSet(firstJwks), {
					issuer: `${secondOrigin}/realms/grove-mcp`,
					audience: mcpResource,
				}),
			).resolves.toMatchObject({ protectedHeader: { kid: firstKeyId } });
		} finally {
			if (second.exitCode === null) {
				second.kill("SIGTERM");
				await once(second, "exit");
			}
		}
	});

	it("fails clearly instead of rotating corrupted signing material", async () => {
		const corruptedPath = join(temporaryDirectory, "corrupted-signing-key.json");
		await writeFile(corruptedPath, '{"version":1,"privateKeyPkcs8":"not-a-key"}', {
			mode: 0o600,
		});
		const failedPort = await availablePort();
		const failedOrigin = `http://127.0.0.1:${String(failedPort)}`;
		let failedStderr = "";
		const failed = spawn(process.execPath, [providerPath], {
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				PORT: String(failedPort),
				PUBLIC_URL: failedOrigin,
				GROVE_MCP_CLIENT_SECRET: mcpSecret,
				GROVE_MCP_RESOURCE: mcpResource,
				GROVE_OIDC_SIGNING_KEY_PATH: corruptedPath,
			},
		});
		failed.stderr.on("data", (chunk: Buffer) => {
			failedStderr += chunk.toString();
		});

		await once(failed, "exit");

		expect(failed.exitCode).not.toBe(0);
		expect(failedStderr).toContain("Grove development OIDC signing key is invalid");
		expect(failedStderr).toContain("remove the corrupted file");
		expect(failedStderr).not.toContain("PRIVATE KEY");
	});

	it("issues short-lived, resource-bound Agent credentials", async () => {
		const clientId = "https://agents.example/janet-development";
		const response = await fetch(`${issuer}/token`, {
			method: "POST",
			headers: {
				authorization: `Basic ${Buffer.from(`${clientId}:${mcpSecret}`).toString("base64")}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "client_credentials",
				resource: mcpResource,
				scope: "grove:mcp grove:agent:enroll",
			}),
		});
		expect(response.status).toBe(200);
		const tokens = (await response.json()) as {
			access_token: string;
			expires_in: number;
			scope: string;
			token_type: string;
		};
		expect(tokens).toMatchObject({
			expires_in: 300,
			scope: "grove:mcp grove:agent:enroll",
			token_type: "Bearer",
		});

		const jwks = (await (await fetch(`${issuer}/jwks`)).json()) as DevelopmentJwks;
		const { payload, protectedHeader } = await jwtVerify(
			tokens.access_token,
			createLocalJWKSet(jwks),
			{
				issuer,
				audience: mcpResource,
				algorithms: ["RS256"],
				requiredClaims: ["sub", "iat", "exp"],
			},
		);
		expect(protectedHeader).toMatchObject({ alg: "RS256", kid: jwks.keys[0]?.kid });
		expect(payload).toMatchObject({
			sub: clientId,
			client_id: clientId,
			scope: "grove:mcp grove:agent:enroll",
		});
		expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
	});

	it.each([
		["missing resource", undefined, "grove:mcp", mcpSecret, 400, "invalid_target"],
		["wrong resource", "https://other.example/mcp", "grove:mcp", mcpSecret, 400, "invalid_target"],
		["unknown scope", mcpResource, "grove:mcp grove:admin", mcpSecret, 400, "invalid_scope"],
		["missing client auth", mcpResource, "grove:mcp", undefined, 401, "invalid_client"],
		["bad client secret", mcpResource, "grove:mcp", "wrong-secret", 401, "invalid_client"],
	] as const)("rejects %s", async (_name, resource, scope, secret, status, expectedError) => {
		const body = new URLSearchParams({ grant_type: "client_credentials", scope });
		if (resource) body.set("resource", resource);
		const response = await fetch(`${issuer}/token`, {
			method: "POST",
			headers: {
				...(secret === undefined
					? {}
					: {
							authorization: `Basic ${Buffer.from(`agent-development:${secret}`).toString("base64")}`,
						}),
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
		});
		expect(response.status).toBe(status);
		await expect(response.json()).resolves.toEqual({ error: expectedError });
	});
});
