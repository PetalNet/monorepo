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
	groveDevelopmentBuild,
	groveOrbDevAuthFlagEnabled,
} from "$lib/server/dev/guard";
import { runGrove } from "$lib/server/runtime";
import { Effect, Result } from "effect";

import type { RequestHandler } from "./$types";

const required = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${name} is required at runtime`);
	return value.replace(/\/$/, "");
};

export const GET: RequestHandler = async (event) => {
	if (!groveDevelopmentBuild || !groveOrbDevAuthFlagEnabled()) return devRouteNotFound();
	const { runDevPreflight } = await import("$lib/server/dev/control-plane");
	return runGrove(
		Effect.gen(function* () {
			const auth = yield* GroveAuth;
			const readiness = yield* Effect.result(auth.readiness);
			const browserSession = yield* Effect.result(auth.inspectSession(event.request.headers));
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
					browserSession:
						Result.isSuccess(browserSession) && browserSession.success
							? { actor: browserSession.success.actor }
							: null,
				}),
			);
		}),
		event,
	).then((report) => Response.json(report, { headers: { "cache-control": "no-store" } }));
};
