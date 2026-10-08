import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Schema } from "effect";
import { decodeJwt, exportJWK, SignJWT } from "jose";
import { expect, it } from "vitest";

import { createExchanger } from "../src/exchanger.ts";
import { githubIssuer } from "../src/policy.ts";
import { application } from "../src/server.ts";
import { startCache } from "./cache-process.ts";

const TokenResponse = Schema.Struct({
	access_token: Schema.String,
	expires_in: Schema.Finite,
	scope: Schema.String,
	team: Schema.String,
});

it("exchanges local issuer tokens and enforces access in unmodified ducktors v2.14.3", async () => {
	const issuerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = {
		...(await exportJWK(issuerKey.publicKey)),
		kid: "local-issuer",
		alg: "RS256",
		use: "sig",
	};
	let jwksRequests = 0;
	const issuer = createServer((request, response) => {
		response.setHeader("content-type", "application/json");

		if (request.url === "/jwks") {
			jwksRequests += 1;
			response.end(JSON.stringify({ keys: [jwk] }));
		} else if (request.url?.endsWith("/3")) {
			response.writeHead(503);
			response.end("{}");
		} else {
			const fork = request.url?.endsWith("/2");

			response.end(
				JSON.stringify({
					head: { repo: { full_name: fork ? "fork/monorepo" : "PetalNet/monorepo" } },
					base: { repo: { full_name: "PetalNet/monorepo" } },
					user: { login: "eli" },
				}),
			);
		}
	});

	await new Promise<void>((resolve) => {
		issuer.listen(0, "127.0.0.1", resolve);
	});

	const address = issuer.address();

	if (!address || typeof address === "string") {
		throw new Error("Missing issuer address");
	}

	const issuerUrl = `http://127.0.0.1:${String(address.port)}`;
	const storage = await mkdtemp(path.join(tmpdir(), "petalnet-cache-"));

	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const exchanger = yield* createExchanger(
						{
							issuer: "https://turbo-cache.petalcat.dev",
							audience: "turbo-cache.petalcat.dev",
							team: "petalnet",
							privateKey: signingKey.privateKey,
							authentikIssuer: "https://id.petalcat.dev/",
							ampWorkspaceIds: [],
							ampProjectIds: [],
							githubToken: "local-test-credential",
							providers: new Map([[githubIssuer, `${issuerUrl}/jwks`]]),
						},
						issuerUrl,
					);
					const server = yield* NodeHttpServer.make(createServer, { port: 0, host: "127.0.0.1" });

					yield* server.serve(application(exchanger));

					if (!("port" in server.address)) {
						return yield* Effect.die("Expected TCP address");
					}

					const base = `http://127.0.0.1:${String(server.address.port)}`;

					yield* Effect.promise(async () => {
						const cache = await startCache(`${base}/.well-known/jwks.json`, storage);
						const cacheUrl = cache.url;
						const mint = (claims: Record<string, unknown> = {}, key = issuerKey.privateKey) =>
							new SignJWT({
								iss: githubIssuer,
								aud: "turbo-cache.petalcat.dev",
								sub: "job",
								iat: Math.floor(Date.now() / 1000),
								exp: Math.floor(Date.now() / 1000) + 300,
								repository: "PetalNet/monorepo",
								event_name: "push",
								ref: "refs/heads/main",
								actor: "eli",
								...claims,
							})
								.setProtectedHeader({ alg: "RS256", kid: "local-issuer" })
								.sign(key);
						const exchange = (token: string) =>
							fetch(`${base}/exchange`, {
								method: "POST",
								headers: { authorization: `Bearer ${token}` },
							});
						const artifact = (token: string, method: string, team = "petalnet") =>
							fetch(`${cacheUrl}/v8/artifacts/abcdef123456?slug=${team}`, {
								method,
								headers: {
									authorization: `Bearer ${token}`,
									"content-type": "application/octet-stream",
									"x-artifact-duration": "1",
								},
								...(method === "PUT" ? { body: "cached artifact" } : {}),
							});

						try {
							const mainResponse = await exchange(await mint());

							expect(mainResponse.status).toBe(200);
							expect(mainResponse.headers.get("cache-control")).toBe("no-store");

							const main = await Schema.decodeUnknownPromise(TokenResponse)(
								await mainResponse.json(),
							);
							const payload = decodeJwt(main.access_token);

							expect(Number(payload.exp) - Number(payload.iat)).toBe(7200);
							expect(main.scope).toBe("read write");
							expect((await artifact(main.access_token, "PUT")).status).toBe(200);

							const prResponse = await exchange(
								await mint({ event_name: "pull_request", ref: "refs/pull/1/merge" }),
							);

							expect(prResponse.status).toBe(200);
							const pr = await Schema.decodeUnknownPromise(TokenResponse)(await prResponse.json());

							expect(pr.scope).toBe("read");
							expect((await artifact(pr.access_token, "PUT")).status).toBe(403);
							const read = await artifact(pr.access_token, "GET");

							expect(read.status).toBe(200);
							expect(await read.text()).toBe("cached artifact");
							expect((await artifact(main.access_token, "GET", "another-team")).status).toBe(403);

							expect(
								(
									await exchange(
										await mint({ event_name: "pull_request", ref: "refs/pull/2/merge" }),
									)
								).status,
							).toBe(403);

							const forged = await mint(
								{},
								generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
							);
							const foreign = await new SignJWT({})
								.setProtectedHeader({ alg: "RS256", kid: "local-issuer" })
								.setIssuer("https://foreign.example")
								.setAudience("turbo-cache.petalcat.dev")
								.setSubject("attacker")
								.setExpirationTime("5m")
								.sign(issuerKey.privateKey);

							await Promise.all(
								[forged, foreign].map(async (invalid) => {
									expect((await exchange(invalid)).status).toBe(403);
									expect([401, 403]).toContain((await artifact(invalid, "GET")).status);
									expect([401, 403]).toContain((await artifact(invalid, "PUT")).status);
								}),
							);

							await Promise.all(
								[
									{ aud: "wrong" },
									{ exp: 1 },
									{ exp: undefined },
									{ sub: undefined },
									{ nbf: Math.floor(Date.now() / 1000) + 600 },
									{ groups: "turbo-cache" },
									{ event_name: "pull_request", ref: "refs/heads/main" },
									{ event_name: "pull_request", ref: "refs/pull/3/merge" },
								].map(async (claims) => {
									expect((await exchange(await mint(claims))).status).toBe(403);
								}),
							);

							expect((await exchange("broken.token.value")).status).toBe(403);
							expect((await fetch(`${base}/exchange`, { method: "POST" })).status).toBe(401);

							const publicKeys = await fetch(`${base}/.well-known/jwks.json`).then((response) =>
								response.text(),
							);

							expect(publicKeys).not.toContain('"d":');

							expect(jwksRequests).toBe(1);

							process.stdout.write(
								"main PUT=200; PR PUT=403, GET=200 (matching bytes); wrong team=403; fork exchange=403; forged/foreign exchange=403 and cache denied; JWKS fetched once; token TTL=7200s\n",
							);
						} finally {
							await cache.close();
						}
					});
				}),
			).pipe(Effect.provide(NodeHttpServer.layerHttpServices)),
		);
	} finally {
		await new Promise<void>((resolve, reject) => {
			issuer.close((error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});

		await rm(storage, { recursive: true, force: true });
	}
}, 30_000);
