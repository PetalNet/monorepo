import * as PgClient from "@effect/sql-pg/PgClient";
import type { EffectQbAdapterRuntime } from "@petalnet/better-auth-effect-qb-adapter";
import { APIError } from "better-auth/api";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";

import { GroveBetterAuthLayer } from "../src/lib/server/auth";
import { BetterAuth, BetterAuthApiError, BetterAuthLayer } from "../src/lib/server/better-auth";

const endpoint = vi.hoisted(() => vi.fn());
const adapter = vi.hoisted(() => ({ runner: undefined as EffectQbAdapterRuntime | undefined }));

vi.mock("@petalnet/better-auth-effect-qb-adapter", () => ({
	createEffectQbAdapter: (runner: EffectQbAdapterRuntime) => {
		adapter.runner = runner;

		return undefined;
	},
}));

vi.mock("better-auth/minimal", () => ({
	betterAuth: () => ({
		$context: Promise.resolve({}),
		api: { getSession: endpoint },
	}),
}));

const auth = BetterAuth.pipe(
	Effect.provide(
		BetterAuthLayer({
			baseURL: "https://auth.example",
			secret: "boundary-test-secret-at-least-32-characters",
		}),
	),
);

it("preserves API error details as a recoverable failure", async () => {
	const cause = new APIError(
		"UNAUTHORIZED",
		{
			code: "SESSION_EXPIRED",
			message: "The session has expired",
		},
		{ "retry-after": "30" },
	);

	endpoint.mockRejectedValueOnce(cause);

	const failure = await Effect.runPromise(
		Effect.flip(Effect.flatMap(auth, (service) => service.getSession(new Headers()))),
	);

	expect(failure).toBeInstanceOf(BetterAuthApiError);

	expect(failure).toMatchObject({
		statusCode: 401,
		code: "SESSION_EXPIRED",
		message: "The session has expired",
		cause,
	});

	if (!(failure instanceof BetterAuthApiError)) {
		throw new TypeError("Expected a recoverable API failure");
	}

	expect(failure.headers?.get("retry-after")).toBe("30");
});

it("keeps unexpected endpoint rejections as defects", async () => {
	const cause = new Error("Unexpected endpoint failure");

	endpoint.mockRejectedValueOnce(cause);

	const exit = await Effect.runPromiseExit(
		Effect.flatMap(auth, (service) => service.getSession(new Headers())),
	);

	expect(Exit.isFailure(exit)).toBe(true);

	if (!Exit.isFailure(exit)) {
		throw new TypeError("Expected an endpoint defect");
	}

	expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
		cause,
	]);
});

it("interrupts adapter callbacks on auth disposal without releasing the borrowed database", async () => {
	const database = {} as PgClient.PgClient;
	let databaseClosed = false;
	let callbackStopped = false;
	const started = Promise.withResolvers<undefined>();
	const parent = ManagedRuntime.make(
		Layer.effect(
			PgClient.PgClient,
			Effect.acquireRelease(Effect.succeed(database), () =>
				Effect.sync(() => {
					databaseClosed = true;
				}),
			),
		),
	);
	const runtime = ManagedRuntime.make(
		GroveBetterAuthLayer({
			baseUrl: "https://grove.example",
			secret: "boundary-test-secret-at-least-32-characters",
			issuer: "https://identity.example",
			clientId: "grove",
			clientSecret: "test-secret",
		}).pipe(Layer.provide(Layer.succeedContext(await parent.context()))),
	);

	try {
		const service = await runtime.runPromise(BetterAuth);
		const runner = adapter.runner;

		if (!runner) {
			throw new TypeError("Expected an adapter runner");
		}

		endpoint.mockImplementationOnce(() =>
			runner.runPromise(
				Effect.gen(function* () {
					const borrowed = yield* PgClient.PgClient;

					expect(borrowed).toBe(database);
					started.resolve(undefined);

					return yield* Effect.never;
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							callbackStopped = true;
						}),
					),
				),
			),
		);

		const pending = Effect.runPromiseExit(service.getSession(new Headers()));

		await started.promise;
		await runtime.dispose();

		expect(Exit.isFailure(await pending)).toBe(true);
		expect(callbackStopped).toBe(true);
		expect(databaseClosed).toBe(false);
		expect(await parent.runPromise(PgClient.PgClient)).toBe(database);
	} finally {
		await runtime.dispose();
		await parent.dispose();
	}

	expect(databaseClosed).toBe(true);
});
