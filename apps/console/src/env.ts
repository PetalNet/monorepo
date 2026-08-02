import { consoleApiBaseSchema, dataModeSchema, glitchtipDsnSchema } from "$lib/env-schemas";
import { defineEnvVars } from "@sveltejs/kit/hooks";
import { Schema } from "effect";

/**
 * SvelteKit's public env seam. Each var is declared with the shared Effect Schema (converted to a
 * Standard Schema), so `$app/env/public` is typed and validated from the same definition that
 * $lib/config and the instrumentation consume.
 */
export const variables = defineEnvVars({
	PUBLIC_CONSOLE_DATA_MODE: {
		public: true,
		static: false,
		description:
			'Console data plane: "mock" serves in-memory fixtures, otherwise the live substrate.',
		schema: Schema.toStandardSchemaV1(dataModeSchema),
	},
	PUBLIC_CONSOLE_API_BASE: {
		public: true,
		static: false,
		description:
			"Override for the console REST base URL; defaults to the request origin + /api/v1.",
		schema: Schema.toStandardSchemaV1(consoleApiBaseSchema),
	},
	PUBLIC_GLITCHTIP_DSN: {
		public: true,
		static: false,
		description:
			"GlitchTip/Sentry DSN for browser and server error reporting; disabled when unset.",
		schema: Schema.toStandardSchemaV1(glitchtipDsnSchema),
	},
});
