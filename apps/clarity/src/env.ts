import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
	SERP_FETCH_URL: { schema: (input) => input ?? "" },
	SERP_INTERNAL_KEY: { schema: (input) => input ?? "" },
});
