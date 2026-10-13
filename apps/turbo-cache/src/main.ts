import { createPrivateKey } from "node:crypto";
import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";

import { createExchanger } from "./exchanger.ts";
import { ampIssuer, githubIssuer } from "./policy.ts";
import { application } from "./server.ts";

const secret = Effect.fn(function* (name: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Config.String(`${name}_FILE`).pipe(Config.withDefault(""));

	return path
		? Redacted.make((yield* fs.readFileString(path)).trim())
		: yield* Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));
});

const program = Effect.gen(function* () {
	const authentikIssuer = yield* Config.String("AUTHENTIK_ISSUER");
	const authentikJwks = yield* Config.String("AUTHENTIK_JWKS_URL");

	if (
		new URL(authentikIssuer).origin !== "https://id.petalcat.dev" ||
		new URL(authentikJwks).origin !== "https://id.petalcat.dev"
	) {
		return yield* Effect.die("Authentik must use https://id.petalcat.dev");
	}

	const privateKey = createPrivateKey(Redacted.value(yield* secret("SIGNING_KEY")));

	if (
		privateKey.asymmetricKeyType !== "rsa" ||
		(privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
	) {
		return yield* Effect.die("SIGNING_KEY must be an RSA (2048 bits or larger) PKCS8 private key");
	}

	const exchanger = yield* createExchanger({
		audience: yield* Config.String("OIDC_AUDIENCE").pipe(
			Config.withDefault("turbo-cache.petalcat.dev"),
		),
		issuer: "https://turbo-cache.petalcat.dev",
		team: yield* Config.String("TURBO_TEAM").pipe(Config.withDefault("petalnet")),
		privateKey,
		authentikIssuer,
		ampWorkspaceIds: (yield* Config.String("AMP_WORKSPACE_IDS").pipe(Config.withDefault("")))
			.split(",")
			.filter(Boolean),
		ampProjectIds: (yield* Config.String("AMP_PROJECT_IDS").pipe(Config.withDefault("")))
			.split(",")
			.filter(Boolean),
		githubToken: yield* secret("GITHUB_READ_TOKEN"),
		providers: new Map([
			[githubIssuer, `${githubIssuer}/.well-known/jwks`],
			[ampIssuer, `${ampIssuer}/jwks.json`],
			[authentikIssuer, authentikJwks],
		]),
	});

	const port = yield* Config.Port("PORT").pipe(Config.withDefault(3001));

	return yield* Layer.launch(
		HttpServer.serve(application(exchanger)).pipe(
			Layer.provide(NodeHttpServer.layer(createServer, { port })),
		),
	);
});

NodeRuntime.runMain(
	program.pipe(
		Effect.provide(
			Layer.mergeAll(
				NodeServices.layer,
				FetchHttpClient.layer.pipe(
					Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" })),
				),
			),
		),
	),
);
