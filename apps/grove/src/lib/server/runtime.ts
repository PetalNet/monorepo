import { building } from "$app/env";
import { DATABASE_URL, GROVE_HOME_OWNER_ISSUER, GROVE_HOME_OWNER_SUBJECT } from "$app/env/private";
import {
	ActorAuthority,
	ActorAuthorityBuildLayer,
	ActorDatabaseError,
	ActorDenied,
	ActorNotCurrent,
	ActorAuthorityLayer,
} from "$lib/server/actors/authority";
import { GroveAuth, GroveAuthBuildLayer } from "$lib/server/auth";
import { GroveAuthLayer } from "$lib/server/auth-runtime";
import {
	LoopCommands,
	LoopCommandsBuildLayer,
	LoopCommandsLayer,
	LoopConflict,
	LoopDatabaseError,
} from "$lib/server/loop/service";
import {
	SproutCommands,
	SproutCommandsBuildLayer,
	SproutCommandsLayer,
} from "$lib/server/sprouts/service";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
	makeEffectSvelteKitRuntime,
	SvelteKitRequestEvent,
	type EffectSvelteKitRuntime,
} from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, Redacted } from "effect";

import { AuthenticationRequired } from "./authorization";
import { SproutDatabaseError, SproutNotFound } from "./sprouts/service";

const required = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${name} is required at runtime`);
	return value;
};

function makeRuntime() {
	let GroveServicesLayer;
	if (building) {
		GroveServicesLayer = Layer.mergeAll(
			GroveAuthBuildLayer,
			ActorAuthorityBuildLayer,
			SproutCommandsBuildLayer,
			LoopCommandsBuildLayer,
		);
	} else {
		if (!DATABASE_URL) throw new Error("DATABASE_URL is required at runtime");
		const actorAuthority = ActorAuthorityLayer({
			homeOwner: {
				issuer: required(GROVE_HOME_OWNER_ISSUER, "GROVE_HOME_OWNER_ISSUER").replace(/\/+$/, ""),
				subject: required(GROVE_HOME_OWNER_SUBJECT, "GROVE_HOME_OWNER_SUBJECT"),
			},
		});
		const consumers = Layer.mergeAll(GroveAuthLayer, SproutCommandsLayer, LoopCommandsLayer).pipe(
			Layer.provide(actorAuthority),
		);
		GroveServicesLayer = Layer.merge(actorAuthority, consumers).pipe(
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
			if (failure instanceof ActorDenied || failure instanceof ActorNotCurrent)
				return { status: 403, message: failure.message };
			if (failure instanceof ActorDatabaseError)
				return { status: 503, message: "Actor authority is unavailable", log: true };
			if (failure instanceof SproutNotFound) return { status: 404, message: failure.message };
			if (failure instanceof SproutDatabaseError)
				return { status: 503, message: "The sprout database is unavailable", log: true };
			if (failure instanceof LoopConflict) return { status: 409, message: failure.message };
			if (failure instanceof LoopDatabaseError)
				return { status: 503, message: failure.message, log: true };
		},
	});
}

let runtime:
	| EffectSvelteKitRuntime<GroveAuth | ActorAuthority | SproutCommands | LoopCommands>
	| undefined;

export const initializeGroveRuntime = () => (runtime ??= makeRuntime());

export const runGrove = <
	A,
	E,
	R extends GroveAuth | ActorAuthority | SproutCommands | LoopCommands | SvelteKitRequestEvent,
>(
	effect: Effect.Effect<A, E, R>,
	event: RequestEvent,
) => initializeGroveRuntime().run(effect, event);

export const handleGrove = initializeGroveRuntime().handle;

export const disposeGroveRuntime = () => runtime?.dispose() ?? Promise.resolve();

if (import.meta.hot) import.meta.hot.dispose(() => void disposeGroveRuntime());
