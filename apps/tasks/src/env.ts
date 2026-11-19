import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
	PUBLIC_GLITCHTIP_DSN: { public: true, schema: (input) => input ?? "" },
	PUBLIC_GLITCHTIP_ENV: { public: true, schema: (input) => input ?? "" },
	ELEVEN_API_KEY: { schema: (input) => input ?? "" },
});
