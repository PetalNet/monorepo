import { APIError } from "better-auth/api";
import { Cause, Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";

import { BetterAuth, BetterAuthApiError, BetterAuthLayer } from "./better-auth";

const endpoint = vi.hoisted(() => vi.fn());

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
