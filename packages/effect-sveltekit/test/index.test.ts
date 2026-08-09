import { isHttpError, type RequestEvent } from "@sveltejs/kit";
import { Cause, Context, Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeEffectSvelteKitRuntime, SvelteKitRequestEvent } from "../src/index.js";

const eventFor = (signal = new AbortController().signal, path = "/example") =>
	({ request: new Request(`https://grove.test${path}`, { signal }) }) as RequestEvent;

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

const expectHttpError = async (result: Promise<unknown>, status: number, message: string) => {
	await expect(result).rejects.toSatisfy(
		(value: unknown) => isHttpError(value, status) && value.body.message === message,
	);
};

afterEach(() => vi.restoreAllMocks());

describe("makeEffectSvelteKitRuntime", () => {
	it("shares initialization, reuses its managed layer, and releases it exactly once", async () => {
		class Value extends Context.Service<Value, number>()("test/Value") {}
		let acquisitions = 0;
		let releases = 0;
		const layer = Layer.effect(
			Value,
			Effect.acquireRelease(
				Effect.sync(() => ++acquisitions),
				() => Effect.sync(() => void ++releases),
			),
		);
		const runtime = makeEffectSvelteKitRuntime(layer);
		const firstInitialization = runtime.initialize();

		expect(runtime.initialize()).toBe(firstInitialization);
		await firstInitialization;
		await expect(runtime.run(Value, eventFor())).resolves.toBe(1);
		await expect(runtime.run(Value, eventFor())).resolves.toBe(1);
		expect(acquisitions).toBe(1);

		const firstDisposal = runtime.dispose();
		expect(runtime.dispose()).toBe(firstDisposal);
		await firstDisposal;
		expect(releases).toBe(1);
	});

	it("isolates RequestEvents between concurrent request fibers", async () => {
		const runtime = makeEffectSvelteKitRuntime(Layer.empty);
		const currentUrl = SvelteKitRequestEvent.useSync((event) => event.request.url).pipe(
			Effect.andThen(Effect.yieldNow),
			Effect.andThen(SvelteKitRequestEvent.useSync((event) => event.request.url)),
		);

		await expect(
			Promise.all([
				runtime.run(currentUrl, eventFor(undefined, "/one")),
				runtime.run(currentUrl, eventFor(undefined, "/two")),
			]),
		).resolves.toEqual(["https://grove.test/one", "https://grove.test/two"]);
		await runtime.dispose();
	});

	it("wraps a SvelteKit handle with runtime services and its request event", async () => {
		class Value extends Context.Service<Value, string>()("test/HandleValue") {}
		const runtime = makeEffectSvelteKitRuntime(Layer.succeed(Value, "from-runtime"));
		const handle = runtime.handle(({ event }) =>
			Effect.gen(function* () {
				const value = yield* Value;
				const request = yield* SvelteKitRequestEvent;
				return new Response(`${value}:${request.request.url}:${event.request.url}`);
			}),
		);
		const event = eventFor(undefined, "/handle");
		const response = await handle({ event, resolve: vi.fn() });

		expect(await response.text()).toBe(
			"from-runtime:https://grove.test/handle:https://grove.test/handle",
		);
		await runtime.dispose();
	});

	it("interrupts on request abort, preserves its exact reason, and finishes cleanup first", async () => {
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, { logCause: vi.fn() });
		const controller = new AbortController();
		const reason = new DOMException("client left", "AbortError");
		let finalized = false;
		const result = runtime.run(
			Effect.never.pipe(Effect.ensuring(Effect.sync(() => void (finalized = true)))),
			eventFor(controller.signal),
		);

		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(finalized).toBe(true);
		await runtime.dispose();
	});

	it("creates a standard AbortError when an aborted signal has no reason", async () => {
		const runtime = makeEffectSvelteKitRuntime(Layer.empty);
		const controller = new AbortController();
		Object.defineProperty(controller.signal, "reason", { value: undefined });
		const event = { request: { signal: controller.signal } } as unknown as RequestEvent;
		const result = runtime.run(Effect.never, event);

		controller.abort();
		await expect(result).rejects.toMatchObject({
			name: "AbortError",
			message: "The request was aborted",
		});
		await runtime.dispose();
	});

	it("interrupts every active request before releasing layer resources", async () => {
		class Resource extends Context.Service<Resource, true>()("test/Resource") {}
		const order: string[] = [];
		const started = deferred();
		const layer = Layer.effect(
			Resource,
			Effect.acquireRelease(Effect.succeed(true as const), () =>
				Effect.sync(() => void order.push("layer released")),
			),
		);
		const runtime = makeEffectSvelteKitRuntime(layer, { logCause: vi.fn() });
		const request = runtime.run(
			Effect.sync(started.resolve).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.sync(() => void order.push("request finalized"))),
			),
			eventFor(),
		);
		await started.promise;

		await runtime.dispose();
		await expect(request).rejects.toThrow("disposing or has been disposed");
		expect(order).toEqual(["request finalized", "layer released"]);
	});

	it("shares disposal reentered from a request finalizer and awaits layer release", async () => {
		class Resource extends Context.Service<Resource, true>()("test/ReentrantResource") {}
		const requestStarted = deferred();
		const requestFinalized = deferred();
		const releaseLayer = deferred();
		const layer = Layer.effect(
			Resource,
			Effect.acquireRelease(Effect.succeed(true as const), () =>
				Effect.promise(() => releaseLayer.promise),
			),
		);
		const runtime = makeEffectSvelteKitRuntime(layer);
		let reentrantDisposal: Promise<void> | undefined;
		const request = runtime.run(
			Effect.sync(requestStarted.resolve).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(
					Effect.sync(() => {
						reentrantDisposal = runtime.dispose();
						requestFinalized.resolve();
					}),
				),
			),
			eventFor(),
		);
		await requestStarted.promise;

		const disposal = runtime.dispose();
		await requestFinalized.promise;
		expect(reentrantDisposal).toBe(disposal);
		let settled = false;
		void disposal.then(() => void (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseLayer.resolve();
		await disposal;
		await expect(request).rejects.toThrow("disposed");
		expect(settled).toBe(true);
	});

	it("finalizes all active request and child fibers exactly once during disposal", async () => {
		const runtime = makeEffectSvelteKitRuntime(Layer.empty);
		const started = [deferred(), deferred(), deferred()];
		const finalizers = vi.fn<(name: string) => void>();
		const requests = started.map((ready, index) =>
			runtime.run(
				Effect.gen(function* () {
					const childStarted = deferred();
					yield* Effect.forkChild(
						Effect.sync(childStarted.resolve).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								Effect.sync(() => {
									finalizers(`child-${String(index)}`);
								}),
							),
						),
					);
					yield* Effect.promise(() => childStarted.promise);
					ready.resolve();
					yield* Effect.never;
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							finalizers(`request-${String(index)}`);
						}),
					),
				),
				eventFor(),
			),
		);
		await Promise.all(started.map(({ promise }) => promise));

		await runtime.dispose();
		await Promise.all(requests.map((request) => expect(request).rejects.toThrow("disposed")));
		expect(finalizers.mock.calls.map(([name]) => name).toSorted()).toEqual([
			"child-0",
			"child-1",
			"child-2",
			"request-0",
			"request-1",
			"request-2",
		]);
	});

	it("stops admission as soon as disposal starts and never executes late effects", async () => {
		const runtime = makeEffectSvelteKitRuntime(Layer.empty);
		const started = deferred();
		const finishFinalizer = deferred();
		const active = runtime.run(
			Effect.sync(started.resolve).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.promise(() => finishFinalizer.promise)),
			),
			eventFor(),
		);
		await started.promise;
		const disposal = runtime.dispose();
		let lateEffectRan = false;
		const late = runtime.run(
			Effect.sync(() => void (lateEffectRan = true)),
			eventFor(),
		);

		await expect(late).rejects.toThrow("disposing or has been disposed");
		expect(lateEffectRan).toBe(false);
		finishFinalizer.resolve();
		await disposal;
		await expect(active).rejects.toThrow("disposing or has been disposed");
		await expect(runtime.initialize()).rejects.toThrow("disposing or has been disposed");
	});

	it("rejects a request when disposal wins immediately after shared initialization", async () => {
		const runtime = makeEffectSvelteKitRuntime(Layer.empty);
		const initialization = runtime.initialize();
		const disposal = initialization.then(runtime.dispose);
		let effectRan = false;

		await expect(
			runtime.run(
				Effect.sync(() => void (effectRan = true)),
				eventFor(),
			),
		).rejects.toThrow("disposing or has been disposed");
		expect(effectRan).toBe(false);
		await disposal;
	});

	it("interrupts initialization cleanly when disposal races a layer build", async () => {
		class Value extends Context.Service<Value, true>()("test/SlowValue") {}
		const started = deferred();
		const neverFinishes = deferred();
		const layer = Layer.effect(
			Value,
			Effect.sync(started.resolve).pipe(
				Effect.andThen(Effect.promise(() => neverFinishes.promise)),
				Effect.as(true as const),
			),
		);
		const logged = vi.fn();
		const runtime = makeEffectSvelteKitRuntime(layer, { logCause: logged });
		const initialization = runtime.initialize();
		await started.promise;

		await runtime.dispose();
		await expect(initialization).rejects.toThrow("disposing or has been disposed");
		expect(logged).not.toHaveBeenCalled();
	});

	it("shares and safely reports a failed layer initialization", async () => {
		class Value extends Context.Service<Value, true>()("test/FailedValue") {}
		const logged = vi.fn();
		const runtime = makeEffectSvelteKitRuntime(
			Layer.effect(Value, Effect.fail("private configuration")),
			{ logCause: logged },
		);
		const first = runtime.initialize();
		const second = runtime.initialize();

		expect(second).toBe(first);
		await expect(first).rejects.toThrow("failed to initialize");
		await expect(second).rejects.toThrow("failed to initialize");
		expect(logged).toHaveBeenCalledOnce();
		expect(logged.mock.calls[0]?.[1]).toBeUndefined();
		await runtime.dispose();
	});

	it("exposes mapped failures without logging ordinary client errors", async () => {
		const logged = vi.fn();
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, {
			mapFailure: (failure) =>
				failure === "missing" ? { status: 404, message: "Sprout not found" } : undefined,
			logCause: logged,
		});

		await expectHttpError(runtime.run(Effect.fail("missing"), eventFor()), 404, "Sprout not found");
		expect(logged).not.toHaveBeenCalled();
		await runtime.dispose();
	});

	it("logs complete causes for explicitly logged mapped failures", async () => {
		const logged = vi.fn();
		const event = eventFor();
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, {
			mapFailure: () => ({ status: 503, message: "Service temporarily unavailable", log: true }),
			logCause: logged,
		});

		await expectHttpError(
			runtime.run(Effect.fail("database details"), event),
			503,
			"Service temporarily unavailable",
		);
		expect(logged).toHaveBeenCalledOnce();
		expect(logged.mock.calls[0]).toMatchObject([
			{ reasons: [{ error: "database details" }] },
			event,
		]);
		await runtime.dispose();
	});

	it.each([undefined, NaN, 399, 600])(
		"sanitizes and logs invalid or absent failure mappings (%s)",
		async (status) => {
			const logged = vi.fn();
			const runtime = makeEffectSvelteKitRuntime(Layer.empty, {
				mapFailure: () =>
					status === undefined ? undefined : { status, message: "must not escape" },
				logCause: logged,
			});

			await expectHttpError(
				runtime.run(Effect.fail("private failure"), eventFor()),
				500,
				"Internal server error",
			);
			expect(logged).toHaveBeenCalledOnce();
			await runtime.dispose();
		},
	);

	it("sanitizes a defect thrown by the failure mapper and logs both causes", async () => {
		const logged = vi.fn();
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, {
			mapFailure: () => {
				throw new Error("private mapper defect");
			},
			logCause: logged,
		});

		await expectHttpError(
			runtime.run(Effect.fail("private original failure"), eventFor()),
			500,
			"Internal server error",
		);
		expect(logged).toHaveBeenCalledOnce();
		expect(logged.mock.calls[0]?.[0]).toMatchObject({
			reasons: [
				{ _tag: "Fail", error: "private original failure" },
				{
					_tag: "Die",
					defect: expect.objectContaining({ message: "private mapper defect" }) as unknown,
				},
			],
		});
		await runtime.dispose();
	});

	it("gives defects precedence over mapped failures from a defecting finalizer", async () => {
		const logged = vi.fn();
		const mapFailure = vi.fn(() => ({ status: 404, message: "Not found" }));
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, { mapFailure, logCause: logged });
		const failureWithDefect = Effect.fail("missing").pipe(
			Effect.ensuring(Effect.die("private finalizer defect")),
		);

		await expectHttpError(runtime.run(failureWithDefect, eventFor()), 500, "Internal server error");
		expect(mapFailure).not.toHaveBeenCalled();
		expect(logged).toHaveBeenCalledOnce();
		await runtime.dispose();
	});

	it("sanitizes multiple failures and unexpected interruption", async () => {
		const logged = vi.fn();
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, { logCause: logged });
		const multiple = Effect.failCause(Cause.combine(Cause.fail("first"), Cause.fail("second")));

		await expectHttpError(runtime.run(multiple, eventFor()), 500, "Internal server error");
		await expectHttpError(runtime.run(Effect.interrupt, eventFor()), 500, "Internal server error");
		expect(logged).toHaveBeenCalledTimes(2);
		await runtime.dispose();
	});

	it("uses the default logger while keeping defect details private", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const runtime = makeEffectSvelteKitRuntime(Layer.empty);

		await expectHttpError(
			runtime.run(Effect.die(new Error("private defect details")), eventFor()),
			500,
			"Internal server error",
		);
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("private defect details"));
		await runtime.dispose();
	});
});
