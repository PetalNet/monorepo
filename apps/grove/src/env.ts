import { building, dev } from "$app/env";
import { defineEnvVars } from "@sveltejs/kit/hooks";
import { Schema } from "effect";

const authSecret = Schema.String.check(Schema.isMinLength(32));

const parseUrl = (value: string) => {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
};
const safeUrl = (value: string, isDev: boolean, originOnly: boolean) => {
	const url = parseUrl(value);
	if (!url || url.username || url.password || url.search || url.hash) return false;
	if (originOnly && url.pathname !== "/") return false;
	if (url.protocol === "https:") return true;
	return (
		isDev &&
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
	);
};
const authUrl = (isDev: boolean) =>
	Schema.NonEmptyString.check(
		Schema.makeFilter(
			(value) => safeUrl(value, isDev, true) || "expected a canonical HTTPS origin",
		),
	);
const oidcIssuer = (isDev: boolean) =>
	Schema.NonEmptyString.check(
		Schema.makeFilter(
			(value) => safeUrl(value, isDev, false) || "expected a canonical HTTPS issuer",
		),
	);

export const authUrlSchema = (isBuilding: boolean, isDev: boolean) => {
	const schema = authUrl(isDev);
	return (isBuilding ? Schema.optional(schema) : schema) as typeof schema;
};

export const oidcIssuerSchema = (isBuilding: boolean, isDev: boolean) => {
	const schema = oidcIssuer(isDev);
	return (isBuilding ? Schema.optional(schema) : schema) as typeof schema;
};

export const mcpResourceSchema = (isBuilding: boolean, isDev: boolean) => {
	const schema = authUrl(isDev);
	return (isBuilding ? Schema.optional(schema) : schema) as typeof schema;
};

export const variables = defineEnvVars({
	BETTER_AUTH_SECRET: {
		public: false,
		static: false,
		description: "Secret used to sign and encrypt Grove authentication state.",
		schema: Schema.toStandardSchemaV1(
			(building ? Schema.optional(authSecret) : authSecret) as typeof authSecret,
		),
	},
	BETTER_AUTH_URL: {
		public: false,
		static: false,
		description: "Canonical public URL used for Grove authentication callbacks.",
		schema: Schema.toStandardSchemaV1(authUrlSchema(building, dev)),
	},
	DATABASE_URL: {
		public: false,
		static: false,
		description: "PostgreSQL connection URL for Grove's durable state.",
		schema: Schema.toStandardSchemaV1(
			(building
				? Schema.optional(Schema.NonEmptyString)
				: Schema.NonEmptyString) as typeof Schema.NonEmptyString,
		),
	},
	GROVE_OIDC_CLIENT_ID: {
		public: false,
		static: false,
		description: "OIDC client ID used only for Grove browser login.",
		schema: Schema.toStandardSchemaV1(
			(building
				? Schema.optional(Schema.NonEmptyString)
				: Schema.NonEmptyString) as typeof Schema.NonEmptyString,
		),
	},
	GROVE_OIDC_CLIENT_SECRET: {
		public: false,
		static: false,
		description: "OIDC client secret used only for Grove browser login.",
		schema: Schema.toStandardSchemaV1(
			(building
				? Schema.optional(Schema.NonEmptyString)
				: Schema.NonEmptyString) as typeof Schema.NonEmptyString,
		),
	},
	GROVE_OIDC_ISSUER: {
		public: false,
		static: false,
		description: "Pinned OIDC issuer used for Grove browser login and discovery.",
		schema: Schema.toStandardSchemaV1(oidcIssuerSchema(building, dev)),
	},
	GROVE_MCP_ISSUER: {
		public: false,
		static: false,
		description: "Pinned authorization-server issuer for MCP bearer tokens.",
		schema: Schema.toStandardSchemaV1(oidcIssuerSchema(building, dev)),
	},
	GROVE_MCP_JWKS_URL: {
		public: false,
		static: false,
		description: "JWKS endpoint for validating MCP bearer tokens.",
		schema: Schema.toStandardSchemaV1(oidcIssuerSchema(building, dev)),
	},
	GROVE_MCP_RESOURCE: {
		public: false,
		static: false,
		description: "Canonical origin of Grove's MCP protected resource.",
		schema: Schema.toStandardSchemaV1(mcpResourceSchema(building, dev)),
	},
});
