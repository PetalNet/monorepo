// Bridges the promise-based external edges (the pg driver facade, external HTTP adapters) into the
// domain's Effect world while keeping the error channel HONEST. The domain models its recoverable
// failures as typed errors; a driver fault or a bug is a defect, never smuggled into `E`. Leaf reads
// and commands wrap their single edge with these helpers so the whole domain→remote→HTTP seam
// composes with `yield*` and carries a deliberately-designed error type — no promise re-wrapping in
// the remotes, no `Effect.runPromise` laundering mid-pipeline.

import { Effect } from "effect";

/**
 * Lift a promise-returning edge into an Effect whose error channel is exactly `E` — the guarded,
 * caller-recoverable failure the domain chose to model. Anything the guard rejects (a pg driver
 * fault, an invariant break) becomes an unrecoverable defect via {@link Effect.die} rather than
 * widening `E` to `unknown`.
 */
export const edge = <A, E>(
	isExpected: (error: unknown) => error is E,
	run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, E> =>
	Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
		Effect.catch((error) => (isExpected(error) ? Effect.fail(error) : Effect.die(error))),
	);
