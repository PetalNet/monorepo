import { DATABASE_URL } from "$app/env/private";
import { SproutServiceLive } from "$lib/server/sprouts/service";
import * as PgClient from "@effect/sql-pg/PgClient";
import { makeEffectSvelteKitRuntime } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, Redacted } from "effect";

import { SproutDatabaseError, SproutNotFound, SproutService } from "./sprouts/service";

function makeRuntime() {
	const DatabaseLive = PgClient.layer({
		url: Redacted.make(DATABASE_URL),
		maxConnections: 5,
	});

	return makeEffectSvelteKitRuntime(
		Layer.orDie(SproutServiceLive.pipe(Layer.provide(DatabaseLive))),
		{
			mapFailure: (failure) => {
				if (failure instanceof SproutNotFound) return { status: 404, message: failure.message };
				if (failure instanceof SproutDatabaseError)
					return { status: 503, message: "The sprout database is unavailable", log: true };
			},
		},
	);
}

let runtime: ReturnType<typeof makeRuntime> | undefined;

export const initializeGroveRuntime = () => (runtime ??= makeRuntime());

export const runGrove = <A, E>(effect: Effect.Effect<A, E, SproutService>, event: RequestEvent) =>
	initializeGroveRuntime().run(effect, event);

export const disposeGroveRuntime = () => runtime?.dispose() ?? Promise.resolve();

if (import.meta.hot) import.meta.hot.dispose(disposeGroveRuntime);
