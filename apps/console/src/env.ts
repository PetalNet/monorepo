import { defineEnvVars } from "@sveltejs/kit/hooks";
import type { StandardSchemaV1 } from "@sveltejs/kit/internal/types";

/**
 * Passthrough Standard Schema for an optional public string. SvelteKit rejects a bare declaration
 * whose value is empty/absent, so we accept `string | undefined` here and let the Effect Config
 * layer ($lib/config) own defaults, mapping, and the typed reads. This file is only the seam that
 * exposes the raw public vars through `$app/env/public`.
 */
const optionalPublicString: StandardSchemaV1<string | undefined, string | undefined> = {
	"~standard": {
		version: 1,
		vendor: "console",
		validate: (value) => ({ value: value as string | undefined }),
	},
};

export const variables = defineEnvVars({
	PUBLIC_CONSOLE_DATA_MODE: {
		public: true,
		static: false,
		description: 'Console data plane: "mock" serves in-memory fixtures, otherwise the live substrate.',
		schema: optionalPublicString,
	},
	PUBLIC_CONSOLE_API_BASE: {
		public: true,
		static: false,
		description: "Override for the console REST base URL; defaults to the request origin + /api/v1.",
		schema: optionalPublicString,
	},
	PUBLIC_GLITCHTIP_DSN: {
		public: true,
		static: false,
		description: "GlitchTip/Sentry DSN for browser and server error reporting; disabled when unset.",
		schema: optionalPublicString,
	},
});
