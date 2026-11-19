import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
	PUBLIC_GOOGLE_MAPS_API_KEY: { public: true, schema: (input) => input ?? "" },
	RESEND_API_KEY: { schema: (input) => input ?? "" },
	EMAIL_FROM: { schema: (input) => input ?? "" },
	APP_URL: { schema: (input) => input ?? "" },
	DATABASE_URL: { schema: (input) => input ?? "" },
	SPOTIFY_CLIENT_ID: { schema: (input) => input ?? "" },
	SPOTIFY_CLIENT_SECRET: { schema: (input) => input ?? "" },
	SPOTIFY_REDIRECT_URI: { schema: (input) => input ?? "" },
});
