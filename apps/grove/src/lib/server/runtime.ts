import { building } from "$app/env";
import { DATABASE_URL } from "$app/env/private";
import { GroveAuth, GroveAuthBuildLayer, GroveAuthLayer } from "$lib/server/auth";
import { ProjectServiceBuildLayer, ProjectServiceLayer } from "$lib/server/projects/service";
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
import { CommandConflict, ProjectDatabaseError, ProjectService } from "./projects/service";
import { SproutDatabaseError, SproutNotFound, SproutService } from "./sprouts/service";

function makeRuntime() {
	const GroveServicesLayer = building
		? Layer.mergeAll(GroveAuthBuildLayer, SproutServiceBuildLayer, ProjectServiceBuildLayer)
		: Layer.mergeAll(GroveAuthLayer, SproutServiceLayer, ProjectServiceLayer).pipe(
				Layer.provide(
					PgClient.layer({
						url: Redacted.make(DATABASE_URL),
						maxConnections: 5,
					}),
				),
			);

	return makeEffectSvelteKitRuntime(Layer.orDie(GroveServicesLayer), {
		mapFailure: (failure) => {
			if (failure instanceof AuthenticationRequired)
				return { status: 401, message: failure.message };
			if (failure instanceof CommandConflict) return { status: 409, message: failure.message };
			if (failure instanceof ProjectDatabaseError)
				return { status: 503, message: "The project database is unavailable", log: true };
			if (failure instanceof SproutNotFound) return { status: 404, message: failure.message };
			if (failure instanceof SproutDatabaseError)
				return { status: 503, message: "The sprout database is unavailable", log: true };
		},
	});
}

let runtime: EffectSvelteKitRuntime<GroveAuth | ProjectService | SproutService> | undefined;

export const initializeGroveRuntime = () => (runtime ??= makeRuntime());

export const runGrove = <
	A,
	E,
	R extends GroveAuth | SproutService | ProjectService | SvelteKitRequestEvent,
>(
	effect: Effect.Effect<A, E, R>,
	event: RequestEvent,
) => initializeGroveRuntime().run(effect, event);

export const handleGrove = initializeGroveRuntime().handle;

export const disposeGroveRuntime = () => runtime?.dispose() ?? Promise.resolve();

if (import.meta.hot) import.meta.hot.dispose(() => void disposeGroveRuntime());
