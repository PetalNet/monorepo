import { building } from "$app/env";
import { DATABASE_URL, GROVE_HOME_OWNER_ISSUER, GROVE_HOME_OWNER_SUBJECT } from "$app/env/private";
import * as PgClient from "@effect/sql-pg/PgClient";
import { mapOperationErrors } from "@petalnet/effect-api";
import { Effect, Layer, Match, Redacted } from "effect";

import { ActorAuthorityBuildLayer, ActorAuthorityLayer } from "#lib/server/actors/authority.ts";
import { GroveAuthLive } from "#lib/server/auth-runtime.ts";
import type { BrowserSessionError } from "#lib/server/auth.ts";
import { GroveAuthBuildLayer } from "#lib/server/auth.ts";

import type { AuthenticationRequired } from "./authorization";
import { projectErrors } from "./projects/api";
import type { ProjectError } from "./projects/service";
import { ProjectServiceLayer, ProjectServiceBuildLayer } from "./projects/service";

type GroveFailure = AuthenticationRequired | ProjectError | BrowserSessionError;

const required = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} is required at runtime`);
	}

	return value;
};

export const GroveServicesLayer = Layer.unwrap(
	Effect.sync(() => {
		let domain;

		if (building) {
			domain = Layer.mergeAll(
				GroveAuthBuildLayer,
				ActorAuthorityBuildLayer,
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
			const consumers = Layer.merge(GroveAuthLive, ProjectServiceLayer).pipe(
				Layer.provide(actorAuthority),
			);

			domain = Layer.merge(actorAuthority, consumers).pipe(
				Layer.provide(
					PgClient.layer({
						url: Redacted.make(DATABASE_URL),
						maxConnections: 5,
					}),
				),
			);
		}

		return domain;
	}),
);

export const mapGroveFailure = (failure: GroveFailure) =>
	Match.value(failure).pipe(
		Match.tags({
			BetterAuthApiError: ({ statusCode, message }) => ({
				status: statusCode,
				message: statusCode >= 500 ? "Browser authentication is unavailable" : message,
				log: statusCode >= 500,
			}),
			BrowserAuthDatabaseError: ({ message }) => ({ status: 503, message, log: true }),
		}),
		Match.orElse(mapOperationErrors(projectErrors)),
	);
