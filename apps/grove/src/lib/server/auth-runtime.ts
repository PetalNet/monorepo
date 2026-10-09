import {
	BETTER_AUTH_SECRET,
	BETTER_AUTH_URL,
	GROVE_OIDC_CLIENT_ID,
	GROVE_OIDC_CLIENT_SECRET,
	GROVE_OIDC_ISSUER,
} from "$app/env/private";
import { Effect, Layer } from "effect";

import { GroveAuthLayer, GroveBetterAuthLayer } from "./auth";

const required = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} is required at runtime`);
	}

	return value;
};

export const GroveAuthLive = Layer.unwrap(
	Effect.sync(() => {
		const config = {
			baseUrl: required(BETTER_AUTH_URL, "BETTER_AUTH_URL"),
			secret: required(BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
			issuer: required(GROVE_OIDC_ISSUER, "GROVE_OIDC_ISSUER"),
			clientId: required(GROVE_OIDC_CLIENT_ID, "GROVE_OIDC_CLIENT_ID"),
			clientSecret: required(GROVE_OIDC_CLIENT_SECRET, "GROVE_OIDC_CLIENT_SECRET"),
		};

		return GroveAuthLayer(config.issuer).pipe(Layer.provide(GroveBetterAuthLayer(config)));
	}),
);
