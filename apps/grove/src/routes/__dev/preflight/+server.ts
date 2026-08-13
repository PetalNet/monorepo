import process from "node:process";

import {
	BETTER_AUTH_URL,
	GROVE_MCP_ISSUER,
	GROVE_MCP_RESOURCE,
	GROVE_OIDC_ISSUER,
} from "$app/env/private";
import { GroveAuth } from "$lib/server/auth";
import {
	devRouteNotFound,
	groveDevControlPlaneEnabled,
	runDevPreflight,
} from "$lib/server/dev/control-plane";
import { runGrove } from "$lib/server/runtime";
import { Effect, Result } from "effect";

import type { RequestHandler } from "./$types";

const required = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${name} is required at runtime`);
	return value.replace(/\/$/, "");
};

export const GET: RequestHandler = (event) => {
	if (!groveDevControlPlaneEnabled()) return devRouteNotFound();
	return runGrove(
		Effect.gen(function* () {
			const auth = yield* GroveAuth;
			const readiness = yield* Effect.result(auth.readiness);
			return yield* Effect.promise(() =>
				runDevPreflight({
					requestOrigin: event.url.origin,
					config: {
						groveOrigin: required(BETTER_AUTH_URL, "BETTER_AUTH_URL"),
						browserIssuer: required(GROVE_OIDC_ISSUER, "GROVE_OIDC_ISSUER"),
						mcpIssuer: required(GROVE_MCP_ISSUER, "GROVE_MCP_ISSUER"),
						mcpResourceOrigin: required(GROVE_MCP_RESOURCE, "GROVE_MCP_RESOURCE"),
						mcpClientCredentialsAvailable:
							typeof process.env.GROVE_MCP_CLIENT_SECRET === "string" &&
							process.env.GROVE_MCP_CLIENT_SECRET.length > 0,
					},
					homeReadiness: Result.isSuccess(readiness) ? readiness.success : undefined,
					actor: event.locals.actor,
				}),
			);
		}),
		event,
	).then((report) => Response.json(report, { headers: { "cache-control": "no-store" } }));
};
