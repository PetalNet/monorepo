import { building, dev } from "$app/env";
import { defineEnvVars } from "@sveltejs/kit/hooks";
import { Schema } from "effect";

import {
	authUrlSchema,
	mcpResourceSchema,
	oidcIssuerSchema,
	optionalWhenBuilding,
} from "./env-schema";

export const variables = defineEnvVars({
	BETTER_AUTH_SECRET: {
		public: false,
		static: false,
		description: "Secret used to sign and encrypt Grove authentication state.",
		schema: Schema.toStandardSchemaV1(
			optionalWhenBuilding(building, Schema.String.check(Schema.isMinLength(32))),
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
		schema: Schema.toStandardSchemaV1(optionalWhenBuilding(building, Schema.NonEmptyString)),
	},
	GROVE_OIDC_CLIENT_ID: {
		public: false,
		static: false,
		description: "OIDC client ID used only for Grove browser login.",
		schema: Schema.toStandardSchemaV1(optionalWhenBuilding(building, Schema.NonEmptyString)),
	},
	GROVE_OIDC_CLIENT_SECRET: {
		public: false,
		static: false,
		description: "OIDC client secret used only for Grove browser login.",
		schema: Schema.toStandardSchemaV1(optionalWhenBuilding(building, Schema.NonEmptyString)),
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
