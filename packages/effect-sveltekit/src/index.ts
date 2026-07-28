import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { Cause, Context, Effect, Exit, Fiber, ManagedRuntime, type Layer } from "effect";

/** The current SvelteKit request, provided only to the fiber handling that request. */
export class SvelteKitRequestEvent extends Context.Service<SvelteKitRequestEvent, RequestEvent>()(
	"@petalnet/effect-sveltekit/RequestEvent",
) {}

export interface PublicFailure {
	readonly status: number;
	readonly message: string;
	/** Log the complete Cause for expected failures that represent infrastructure faults. */
	readonly log?: boolean;
}

export interface EffectSvelteKitOptions {
	readonly mapFailure?: (failure: unknown) => PublicFailure | undefined;
	readonly logCause?: (cause: Cause.Cause<unknown>, event: RequestEvent | undefined) => void;
}

const defaultLogCause: NonNullable<EffectSvelteKitOptions["logCause"]> = (cause) => {
	console.error(Cause.pretty(cause));
};

/**
 * Full lifecycle union. `dispose()` mutates `state` across request/init `await`s, so the static
 * narrowing TypeScript infers from the pre-`await` `state !== "open"` guards is stale by the time
 * execution resumes. The `state as RuntimeState` reads below re-widen past that stale narrowing so
 * the disposed-during-request guard is preserved (and not flagged unnecessary).
 */
type RuntimeState = "open" | "disposing" | "disposed";

const disposedError = () => new Error("The Effect runtime is disposing or has been disposed");

const validPublicFailure = (failure: PublicFailure | undefined): failure is PublicFailure =>
	failure !== undefined &&
	Number.isInteger(failure.status) &&
	failure.status >= 400 &&
	failure.status <= 599;

/**
 * Own one reusable ManagedRuntime and run ordinary Effects at the SvelteKit request boundary.
 *
 * SvelteKit has no portable server teardown hook, so the application must call `dispose` from its
 * adapter's shutdown integration. AbortSignal interruption is cooperative: synchronous work and
 * APIs that ignore Effect interruption can still run to completion.
 */
export function makeEffectSvelteKitRuntime<R, ER>(
	layer: Layer.Layer<R, ER>,
	options: EffectSvelteKitOptions = {},
) {
	const runtime = ManagedRuntime.make(layer);
	const logCause = options.logCause ?? defaultLogCause;
	const activeFibers = new Set<Fiber.Fiber<unknown, unknown>>();
	let state: RuntimeState = "open";
	let initialization: Promise<void> | undefined;
	let initializationFiber: Fiber.Fiber<unknown, unknown> | undefined;
	let disposal: Promise<void> | undefined;

	const initialize = (): Promise<void> => {
		if (state !== "open") return Promise.reject(disposedError());
		return (initialization ??= (async () => {
			const fiber = runtime.runFork(Effect.void);
			initializationFiber = fiber;
			const exit = await Effect.runPromise(Fiber.await(fiber));
			initializationFiber = undefined;
			if (Exit.isSuccess(exit)) return;
			if (Cause.hasInterruptsOnly(exit.cause) && (state as RuntimeState) !== "open")
				throw disposedError();
			logCause(exit.cause, undefined);
			throw new Error("The Effect runtime failed to initialize");
		})());
	};

	const run = async <A, E>(
		effect: Effect.Effect<A, E, R | SvelteKitRequestEvent>,
		event: RequestEvent,
	): Promise<A> => {
		await initialize();
		if (state !== "open") throw disposedError();

		const fiber = runtime.runFork(Effect.provideService(effect, SvelteKitRequestEvent, event), {
			signal: event.request.signal,
		});
		activeFibers.add(fiber);
		const exit = await Effect.runPromise(Fiber.await(fiber)).finally(() => {
			activeFibers.delete(fiber);
		});
		if (Exit.isSuccess(exit)) return exit.value;

		if (Cause.hasDies(exit.cause)) {
			logCause(exit.cause, event);
			error(500, "Internal server error");
		}

		if (event.request.signal.aborted && Cause.hasInterruptsOnly(exit.cause)) {
			throw (
				event.request.signal.reason ?? new DOMException("The request was aborted", "AbortError")
			);
		}
		if (Cause.hasInterruptsOnly(exit.cause) && (state as RuntimeState) !== "open")
			throw disposedError();
		if (Cause.hasInterrupts(exit.cause)) {
			logCause(exit.cause, event);
			error(500, "Internal server error");
		}

		const failures = exit.cause.reasons.filter(Cause.isFailReason);
		const failure = failures[0];
		if (failure === undefined || failures.length !== 1) {
			logCause(exit.cause, event);
			error(500, "Internal server error");
		}
		let exposed: PublicFailure | undefined;
		try {
			exposed = options.mapFailure?.(failure.error);
		} catch (defect) {
			logCause(Cause.combine(exit.cause, Cause.die(defect)), event);
			error(500, "Internal server error");
		}
		if (!validPublicFailure(exposed)) {
			logCause(exit.cause, event);
			error(500, "Internal server error");
		}
		if (exposed.log) logCause(exit.cause, event);
		error(exposed.status, exposed.message);
	};

	const dispose = (): Promise<void> => {
		if (disposal) return disposal;
		state = "disposing";
		const teardown = async (): Promise<void> => {
			try {
				if (initializationFiber) await Effect.runPromise(Fiber.interrupt(initializationFiber));
				await Effect.runPromise(Fiber.interruptAll(activeFibers));
				await runtime.dispose();
			} finally {
				state = "disposed";
			}
		};
		disposal = Promise.resolve().then(teardown);
		return disposal;
	};

	return { initialize, run, dispose } as const;
}
