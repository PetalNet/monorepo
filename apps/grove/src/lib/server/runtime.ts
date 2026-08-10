import { building } from "$app/env";
import { DATABASE_URL } from "$app/env/private";
import { GroveAuth, GroveAuthBuildLayer, GroveAuthLayer } from "$lib/server/auth";
import { SproutServiceBuildLayer, SproutServiceLayer } from "$lib/server/sprouts/service";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
	makeEffectSvelteKitRuntime,
	SvelteKitRequestEvent,
	type EffectSvelteKitRuntime,
} from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, Redacted } from "effect";

import { AuthenticationRequired } from "./authorization";
import { SproutDatabaseError, SproutNotFound, SproutService } from "./sprouts/service";

function makeRuntime() {
	let GroveServicesLayer;
	if (building) {
		GroveServicesLayer = Layer.merge(GroveAuthBuildLayer, SproutServiceBuildLayer);
	} else {
		if (!DATABASE_URL) throw new Error("DATABASE_URL is required at runtime");
		GroveServicesLayer = Layer.merge(GroveAuthLayer, SproutServiceLayer).pipe(
			Layer.provide(
				PgClient.layer({
					url: Redacted.make(DATABASE_URL),
					maxConnections: 5,
				}),
			),
		);
	}

	return makeEffectSvelteKitRuntime(Layer.orDie(GroveServicesLayer), {
		mapFailure: (failure) => {
			if (failure instanceof AuthenticationRequired)
				return { status: 401, message: failure.message };
			if (failure instanceof SproutNotFound) return { status: 404, message: failure.message };
			if (failure instanceof SproutDatabaseError)
				return { status: 503, message: "The sprout database is unavailable", log: true };
		},
	});
}

let runtime: EffectSvelteKitRuntime<GroveAuth | SproutService> | undefined;

export const initializeGroveRuntime = () => (runtime ??= makeRuntime());

export const runGrove = <A, E, R extends GroveAuth | SproutService | SvelteKitRequestEvent>(
	effect: Effect.Effect<A, E, R>,
	event: RequestEvent,
) => initializeGroveRuntime().run(effect, event);

export const handleGrove = initializeGroveRuntime().handle;

export const disposeGroveRuntime = () => runtime?.dispose() ?? Promise.resolve();

if (import.meta.hot) import.meta.hot.dispose(() => void disposeGroveRuntime());
