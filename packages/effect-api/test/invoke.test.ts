import { Cause, Effect, Exit, Schema, SchemaTransformation } from "effect";
import { describe, expect, it, vi } from "vitest";

import { InvocationFailure, invokeOperation } from "../src/invoke.js";
import { type ApiOperation, operation } from "../src/operation.js";

const base = operation({
	name: "invoke.test",
	description: "Invocation boundary",
	method: "POST",
	path: "/",
	input: Schema.Unknown,
	output: Schema.Unknown,
	handler: Effect.succeed,
});

const failureOf = (exit: Exit.Exit<unknown, InvocationFailure>) => {
	expect(Exit.isFailure(exit)).toBe(true);

	if (Exit.isSuccess(exit)) {
		throw new Error("Expected failure");
	}

	const reason = exit.cause.reasons[0];

	if (!reason || !Cause.isFailReason(reason)) {
		throw new Error("Expected typed failure");
	}

	expect(reason.error).toBeInstanceOf(InvocationFailure);

	return reason.error;
};

describe("invokeOperation", () => {
	it.each([NaN, Infinity, 399, 600, 400.5])(
		"rejects invalid static status %s at declaration",
		(status) => {
			expect(() =>
				operation({
					name: "invalid",
					description: "Invalid status",
					input: Schema.Unknown,
					output: Schema.Unknown,
					handler: () => Effect.fail({ _tag: "Rejected" as const }),
					errors: { Rejected: { status } },
				}),
			).toThrow(/integer between 400 and 599/);
		},
	);

	it.each(["private", { message: "private" }, { _tag: "Unknown", message: "private" }])(
		"sanitizes unknown or untagged failures %s",
		async (error) => {
			const logCause = vi.fn();
			const message = vi.fn(() => "Public message");
			const exit = await Effect.runPromiseExit(
				invokeOperation(
					{
						...base,
						handle: () => Effect.fail(error),
						errors: { Rejected: { status: 403, message } },
					},
					null,
					logCause,
				),
			);

			expect(failureOf(exit)).toMatchObject({ status: 500, message: "The operation failed" });
			expect(message).not.toHaveBeenCalled();
			expect(logCause).toHaveBeenCalledOnce();
		},
	);

	it("passes the tagged error to its declared message callback", async () => {
		const error = { _tag: "Rejected" as const, message: "Public detail" };
		const message = vi.fn((failure: typeof error) => failure.message);
		const declared = operation({
			name: "message",
			description: "Message",
			input: Schema.Unknown,
			output: Schema.Unknown,
			handler: () => Effect.fail(error),
			errors: { Rejected: { status: 409, message } },
		});
		const logCause = vi.fn();
		const exit = await Effect.runPromiseExit(invokeOperation(declared, null, logCause));

		expect(failureOf(exit)).toMatchObject({ status: 409, message: "Public detail" });
		expect(message).toHaveBeenCalledExactlyOnceWith(error);
		expect(logCause).not.toHaveBeenCalled();
	});

	it("is lazy and performs an asynchronous input transformation exactly once per execution", async () => {
		const decode = vi.fn((value: string) =>
			Effect.promise(async () => {
				await Promise.resolve();

				return Number(value);
			}),
		);
		const input = Schema.String.pipe(
			Schema.decodeTo(
				Schema.Finite,
				SchemaTransformation.transformEffect({
					decode,
					encode: (value) => Effect.succeed(String(value)),
				}),
			),
		);
		const handle = vi.fn((value: unknown) => Effect.succeed(value));
		const logCause = vi.fn();
		const invocation = invokeOperation({ ...base, input, handle }, "21", logCause);

		expect(decode).not.toHaveBeenCalled();
		expect(handle).not.toHaveBeenCalled();
		await expect(Effect.runPromise(invocation)).resolves.toBe(21);
		expect(decode).toHaveBeenCalledOnce();
		expect(handle).toHaveBeenCalledExactlyOnceWith(21);
		await expect(Effect.runPromise(invocation)).resolves.toBe(21);
		expect(decode).toHaveBeenCalledTimes(2);
		expect(logCause).not.toHaveBeenCalled();
	});

	it("returns schema validation failures on the typed 400 channel without invoking or logging", async () => {
		const handle = vi.fn(() => Effect.void);
		const logCause = vi.fn();
		const exit = await Effect.runPromiseExit(
			invokeOperation(
				{ ...base, input: Schema.Struct({ id: Schema.String }), handle },
				{},
				logCause,
			),
		);

		expect(failureOf(exit)).toMatchObject({
			status: 400,
			code: "invalid_input",
			message: expect.stringContaining("id") as unknown,
		});

		expect(handle).not.toHaveBeenCalled();
		expect(logCause).not.toHaveBeenCalled();
	});

	it.each(["throw", "die"] as const)(
		"sanitizes and logs input decoder %s exactly once",
		async (mode) => {
			const input = Schema.String.pipe(
				Schema.decodeTo(
					Schema.String,
					SchemaTransformation.transformEffect<string, string>({
						decode: () => {
							if (mode === "throw") {
								throw new Error("private-decoder-marker");
							}

							return Effect.die("private-decoder-marker");
						},
						encode: Effect.succeed,
					}),
				),
			);
			const logCause = vi.fn();
			const handle = vi.fn(() => Effect.void);
			const exit = await Effect.runPromiseExit(
				invokeOperation({ ...base, input, handle }, "input", logCause),
			);

			expect(failureOf(exit)).toMatchObject({
				status: 500,
				code: "operation_failed",
				message: "The operation failed",
			});

			expect(JSON.stringify(failureOf(exit))).not.toContain("private-decoder-marker");
			expect(logCause).toHaveBeenCalledOnce();

			expect(Cause.pretty(logCause.mock.calls[0]?.[1] as Cause.Cause<unknown>)).toContain(
				"private-decoder-marker",
			);

			expect(handle).not.toHaveBeenCalled();
		},
	);

	it("validates decoded output without replaying transformations and preserves the original value", async () => {
		const value = { count: 21, extra: true };
		const logCause = vi.fn();
		const output = Schema.Struct({ count: Schema.FiniteFromString });

		await expect(
			Effect.runPromise(
				invokeOperation({ ...base, output, handle: () => Effect.succeed(value) }, null, logCause),
			),
		).resolves.toBe(value);

		expect(logCause).not.toHaveBeenCalled();
	});

	it.each(["invalid", "defect"] as const)(
		"sanitizes %s output without consulting handler mappers",
		async (mode) => {
			const output = Schema.String.check(
				Schema.makeFilter(() => {
					if (mode === "defect") {
						throw new Error("private-output-marker");
					}

					return false;
				}),
			);
			const logCause = vi.fn();
			const message = vi.fn(() => "Public message");
			const exit = await Effect.runPromiseExit(
				invokeOperation(
					{
						...base,
						output,
						errors: { Rejected: { status: 400, message } },
						handle: () => Effect.succeed("private-output-marker"),
					},
					null,
					logCause,
				),
			);

			expect(failureOf(exit)).toMatchObject({ status: 500, message: "The operation failed" });
			expect(message).not.toHaveBeenCalled();
			expect(logCause).toHaveBeenCalledOnce();
			const logged = logCause.mock.calls[0]?.[1] as Cause.Cause<unknown>;

			if (mode === "defect") {
				expect(Cause.pretty(logged)).toContain("private-output-marker");
			} else {
				expect(Cause.hasFails(logged)).toBe(true);
			}

			expect(JSON.stringify(failureOf(exit))).not.toContain("private-output-marker");
		},
	);

	it.each([422, 503])(
		"preserves mapped %i failures and logs only server errors",
		async (status) => {
			const logCause = vi.fn();
			const exit = await Effect.runPromiseExit(
				invokeOperation(
					{
						...base,
						handle: () => Effect.fail({ _tag: "Rejected", detail: "private" }),
						errors: { Rejected: { status, message: "Public message" } },
					},
					null,
					logCause,
				),
			);

			expect(failureOf(exit)).toMatchObject({
				status,
				code: "operation_failed",
				message: "Public message",
			});

			expect(logCause).toHaveBeenCalledTimes(status >= 500 ? 1 : 0);
		},
	);

	it.each([
		Cause.combine(
			Cause.fail({ _tag: "Rejected", detail: "private-first" }),
			Cause.fail({ _tag: "Rejected", detail: "private-second" }),
		),
		Cause.combine(
			Cause.fail({ _tag: "Rejected", detail: "private-failure" }),
			Cause.die("private-defect"),
		),
		Cause.combine(Cause.fail({ _tag: "Rejected", detail: "private-failure" }), Cause.interrupt()),
	])("sanitizes multiple and mixed causes before mapping", async (cause) => {
		const logCause = vi.fn();
		const message = vi.fn(() => "Public message");
		const exit = await Effect.runPromiseExit(
			invokeOperation(
				{
					...base,
					handle: () => Effect.failCause(cause),
					errors: { Rejected: { status: 400, message } },
				},
				null,
				logCause,
			),
		);

		expect(failureOf(exit)).toMatchObject({ status: 500, message: "The operation failed" });
		expect(message).not.toHaveBeenCalled();
		expect(logCause).toHaveBeenCalledOnce();
	});

	it.each<Partial<ApiOperation<never>>>([
		{ errors: { Rejected: { status: NaN } } },
		{ errors: { Rejected: { status: 399 } } },
		{ errors: { Rejected: { status: 600 } } },
		{ errors: { Rejected: { status: 400.5 } } },
		{
			errors: {
				Rejected: {
					status: 400,
					message: () => {
						throw new Error("private-mapper");
					},
				},
			},
		},
		{ errors: { Rejected: { status: 400, message: () => 42 as unknown as string } } },
	])(
		"guards fabricated static statuses and invalid or throwing message callbacks",
		async (declarations) => {
			const logCause = vi.fn();
			const exit = await Effect.runPromiseExit(
				invokeOperation(
					{
						...base,
						handle: () => Effect.fail({ _tag: "Rejected", detail: "private" }),
						...declarations,
					},
					null,
					logCause,
				),
			);

			expect(failureOf(exit)).toMatchObject({ status: 500, message: "The operation failed" });
			expect(logCause).toHaveBeenCalledOnce();
		},
	);

	it("contains synchronous handler throws lazily", async () => {
		const handle = vi.fn((): Effect.Effect<never> => {
			throw new Error("private-handler");
		});
		const logCause = vi.fn();
		const invocation = invokeOperation({ ...base, handle }, null, logCause);

		expect(handle).not.toHaveBeenCalled();
		expect(failureOf(await Effect.runPromiseExit(invocation))).toMatchObject({ status: 500 });
		expect(logCause).toHaveBeenCalledOnce();
	});

	it("propagates unprompted interruption without logging or a typed failure", async () => {
		const logCause = vi.fn();
		const exit = await Effect.runPromiseExit(
			invokeOperation({ ...base, handle: () => Effect.interrupt }, null, logCause),
		);

		expect(Exit.isFailure(exit)).toBe(true);

		if (Exit.isFailure(exit)) {
			expect(Cause.hasInterrupts(exit.cause)).toBe(true);
			expect(Cause.hasFails(exit.cause)).toBe(false);
		}

		expect(logCause).not.toHaveBeenCalled();
	});

	it("propagates client cancellation of an in-flight handler", async () => {
		const controller = new AbortController();
		const logCause = vi.fn();
		const started = Promise.withResolvers<undefined>();
		const invocation = invokeOperation(
			{
				...base,
				handle: () =>
					Effect.sync(() => {
						started.resolve(undefined);
					}).pipe(Effect.andThen(Effect.never)),
			},
			null,
			logCause,
		);
		const running = Effect.runPromiseExit(invocation, { signal: controller.signal });

		await started.promise;
		controller.abort();
		const exit = await running;

		expect(Exit.isFailure(exit)).toBe(true);

		if (Exit.isFailure(exit)) {
			expect(Cause.hasInterrupts(exit.cause)).toBe(true);
			expect(Cause.hasFails(exit.cause)).toBe(false);
		}

		expect(logCause).not.toHaveBeenCalled();
	});
});
