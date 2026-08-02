import { defineEnvVars } from "@sveltejs/kit/hooks";
import { Schema } from "effect";

export const variables = defineEnvVars({
	DATABASE_URL: {
		public: false,
		static: false,
		description: "PostgreSQL connection URL for Grove's durable state.",
		schema: Schema.toStandardSchemaV1(Schema.NonEmptyString),
	},
});
