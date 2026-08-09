import { building, dev } from "$app/env";
import { defineEnvVars } from "@sveltejs/kit/hooks";
import { Schema } from "effect";

const canonicalAuthUrl = Schema.NonEmptyString.check(Schema.isPattern(/^https:\/\//));
const authSecret = Schema.String.check(Schema.isMinLength(32));

export const authUrlSchema = (building: boolean, dev: boolean) =>
	building || dev ? Schema.optional(Schema.NonEmptyString) : canonicalAuthUrl;

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
});
