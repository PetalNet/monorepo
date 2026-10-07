import { building } from "$app/env";
import { DATABASE_URL, GROVE_HOME_OWNER_ISSUER, GROVE_HOME_OWNER_SUBJECT } from "$app/env/private";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { ApiServer } from "@petalnet/effect-api";
import type { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import {
	makeEffectSvelteKitRuntime,
	type EffectSvelteKitRuntime,
} from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import type { Effect } from "effect";
import { Layer, Match, Redacted } from "effect";

import type { ActorAuthority } from "#lib/server/actors/authority.ts";
import { ActorAuthorityBuildLayer, ActorAuthorityLayer } from "#lib/server/actors/authority.ts";
import { GroveAuthLayer } from "#lib/server/auth-runtime.ts";
import type { BrowserSessionError, GroveAuth } from "#lib/server/auth.ts";
import { GroveAuthBuildLayer } from "#lib/server/auth.ts";
import type { SproutCommands, SproutError } from "#lib/server/sprouts/service.ts";
import { SproutCommandsBuildLayer, SproutCommandsLayer } from "#lib/server/sprouts/service.ts";

import { groveApi } from "./api";
import type { AuthenticationRequired } from "./authorization";
import type { ProjectError, ProjectService } from "./projects/service";
import { ProjectServiceLayer, ProjectServiceBuildLayer } from "./projects/service";

type GroveFailure = AuthenticationRequired | ProjectError | SproutError | BrowserSessionError;

const required = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} is required at runtime`);
	}

	return value;
};

function makeRuntime() {
	let GroveServicesLayer;

	if (building) {
		GroveServicesLayer = Layer.mergeAll(
			GroveAuthBuildLayer,
			ActorAuthorityBuildLayer,
			SproutCommandsBuildLayer,
			ProjectServiceBuildLayer,
		);
	} else {
		if (!DATABASE_URL) {
			throw new Error("DATABASE_URL is required at runtime");
		}

		const actorAuthority = ActorAuthorityLayer({
			homeOwner: {
				issuer: required(GROVE_HOME_OWNER_ISSUER, "GROVE_HOME_OWNER_ISSUER").replace(/\/+$/, ""),
				subject: required(GROVE_HOME_OWNER_SUBJECT, "GROVE_HOME_OWNER_SUBJECT"),
			},
		});
		const consumers = Layer.mergeAll(GroveAuthLayer, SproutCommandsLayer, ProjectServiceLayer).pipe(
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

	return makeEffectSvelteKitRuntime(Layer.orDie(Layer.merge(GroveServicesLayer, groveApi.layer)), {
		mapFailure: (failure: GroveFailure) =>
			Match.value(failure).pipe(
				Match.tags({
					AuthenticationRequired: ({ message }) => ({ status: 401, message }),
					ActorDenied: ({ message }) => ({ status: 403, message }),
					ActorNotCurrent: ({ message }) => ({ status: 403, message }),
					ActorDatabaseError: () => ({
						status: 503,
						message: "Actor authority is unavailable",
						log: true,
					}),
					SproutNotFound: ({ message }) => ({ status: 404, message }),
					CommandConflict: ({ message }) => ({ status: 409, message }),
					FenceConflict: ({ message }) => ({ status: 409, message }),
					ProjectDatabaseError: ({ message }) => ({ status: 503, message, log: true }),
					SproutDatabaseError: () => ({
						status: 503,
						message: "The sprout database is unavailable",
						log: true,
					}),
				}),
				Match.orElse(() => undefined),
			),
	});
}

let runtime:
	| EffectSvelteKitRuntime<
			GroveAuth | ActorAuthority | SproutCommands | ProjectService | ApiServer,
			GroveFailure
	  >
	| undefined;

export const initializeGroveRuntime = () => (runtime ??= makeRuntime());

export const runGrove = <
	A,
	R extends
		| GroveAuth
		| ActorAuthority
		| SproutCommands
		| ProjectService
		| SvelteKitRequestEvent
		| ApiServer,
>(
	effect: Effect.Effect<A, GroveFailure, R>,
	event: RequestEvent,
) => initializeGroveRuntime().run(effect, event);

export const handleGrove = initializeGroveRuntime().handle;

export const disposeGroveRuntime = () => runtime?.dispose() ?? Promise.resolve();

if (import.meta.hot) {
	import.meta.hot.dispose(() => void disposeGroveRuntime());
}
