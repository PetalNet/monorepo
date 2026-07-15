import { get_server_runtime_or_throw } from "svelte-effect-runtime/server";
import type { Effect } from "effect";

export const runServerEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	get_server_runtime_or_throw().runPromise(effect);
