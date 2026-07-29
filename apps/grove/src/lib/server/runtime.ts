import { DATABASE_URL } from "$app/env/private";
import { GroveAuth, GroveAuthLayer } from "$lib/server/auth";
import { SproutServiceLayer } from "$lib/server/sprouts/service";
import * as PgClient from "@effect/sql-pg/PgClient";
import { makeEffectSvelteKitRuntime } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, Redacted } from "effect";

import { SproutDatabaseError, SproutNotFound, SproutService } from "./sprouts/service";

function makeRuntime() {
	const DatabaseLayer = PgClient.layer({
		url: Redacted.make(DATABASE_URL),
		maxConnections: 5,
	});
	const GroveServicesLayer = Layer.merge(GroveAuthLayer, SproutServiceLayer).pipe(
		Layer.provide(DatabaseLayer),
	);

	return makeEffectSvelteKitRuntime(Layer.orDie(GroveServicesLayer), {
		mapFailure: (failure) => {
			if (failure instanceof SproutNotFound) return { status: 404, message: failure.message };
			if (failure instanceof SproutDatabaseError)
				return { status: 503, message: "The sprout database is unavailable", log: true };
		},
	});
}

let runtime: ReturnType<typeof makeRuntime> | undefined;

export const initializeGroveRuntime = () => (runtime ??= makeRuntime());

export const runGrove = <A, E, R extends GroveAuth | SproutService>(
	effect: Effect.Effect<A, E, R>,
	event: RequestEvent,
) => initializeGroveRuntime().run(effect, event);

export const disposeGroveRuntime = () => runtime?.dispose() ?? Promise.resolve();

if (import.meta.hot) import.meta.hot.dispose(() => void disposeGroveRuntime());
