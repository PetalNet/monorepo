import { building, dev } from "$app/env";
import { defineEnvVars } from "@sveltejs/kit/hooks";
import { Schema } from "effect";

const authSecret = Schema.String.check(Schema.isMinLength(32));

const safeUrl = Schema.NonEmptyString.check(
	Schema.makeFilter((value) => {
		if (!URL.canParse(value)) return false;

		const url = new URL(value);
		if (url.username || url.password || url.search || url.hash) return false;
		if (url.protocol === "https:") return true;
		return (
			dev &&
			url.protocol === "http:" &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
		);
	}),
);
const authUrl = safeUrl.check(
	Schema.makeFilter(
		(value) => URL.parse(value)?.pathname === "/" || "expected a canonical HTTPS origin",
	),
);

export const authUrlSchema = building ? Schema.optional(authUrl) : authUrl;
export const oidcIssuerSchema = building ? Schema.optional(safeUrl) : safeUrl;
export const mcpResourceSchema = building ? Schema.optional(authUrl) : authUrl;

export const variables = defineEnvVars({
	BETTER_AUTH_SECRET: {
		public: false,
		static: false,
		description: "Secret used to sign and encrypt Grove authentication state.",
		schema: Schema.toStandardSchemaV1(building ? Schema.optional(authSecret) : authSecret),
	},
	BETTER_AUTH_URL: {
		public: false,
		static: false,
		description: "Canonical public URL used for Grove authentication callbacks.",
		schema: Schema.toStandardSchemaV1(authUrlSchema),
	},
	DATABASE_URL: {
		public: false,
		static: false,
		description: "PostgreSQL connection URL for Grove's durable state.",
		schema: Schema.toStandardSchemaV1(
			building ? Schema.optional(Schema.NonEmptyString) : Schema.NonEmptyString,
		),
	},
	GROVE_OIDC_CLIENT_ID: {
		public: false,
		static: false,
		description: "OIDC client ID used only for Grove browser login.",
		schema: Schema.toStandardSchemaV1(
			building ? Schema.optional(Schema.NonEmptyString) : Schema.NonEmptyString,
		),
	},
	GROVE_OIDC_CLIENT_SECRET: {
		public: false,
		static: false,
		description: "OIDC client secret used only for Grove browser login.",
		schema: Schema.toStandardSchemaV1(
			building ? Schema.optional(Schema.NonEmptyString) : Schema.NonEmptyString,
		),
	},
	GROVE_OIDC_ISSUER: {
		public: false,
		static: false,
		description: "Pinned OIDC issuer used for Grove browser login and discovery.",
		schema: Schema.toStandardSchemaV1(oidcIssuerSchema),
	},
	GROVE_MCP_ISSUER: {
		public: false,
		static: false,
		description: "Pinned authorization-server issuer for MCP bearer tokens.",
		schema: Schema.toStandardSchemaV1(oidcIssuerSchema),
	},
	GROVE_MCP_JWKS_URL: {
		public: false,
		static: false,
		description: "JWKS endpoint for validating MCP bearer tokens.",
		schema: Schema.toStandardSchemaV1(oidcIssuerSchema),
	},
	GROVE_MCP_RESOURCE: {
		public: false,
		static: false,
		description: "Canonical origin of Grove's MCP protected resource.",
		schema: Schema.toStandardSchemaV1(mcpResourceSchema),
	},
});
