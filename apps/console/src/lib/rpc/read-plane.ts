import { readPlaneRemote, type ReadPlane, type ReadPlaneResult } from "$lib/operations.remote";
import type { Effect } from "effect";

type ReadEffect<A> =
	ReturnType<typeof readPlaneRemote> extends Effect.Effect<unknown, infer E, infer R>
		? Effect.Effect<A, E, R>
		: never;

/** Correlates each plane literal with its domain result outside the remote export module. */
export function readPlane<P extends ReadPlane>(plane: P): ReadEffect<ReadPlaneResult[P]> {
	return readPlaneRemote(plane) as unknown as ReadEffect<ReadPlaneResult[P]>;
}
