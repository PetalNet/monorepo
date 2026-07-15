import * as Sentry from "@sentry/sveltekit";
import { ClientRuntime } from "svelte-effect-runtime";

ClientRuntime.make();

if (import.meta.env.PUBLIC_GLITCHTIP_DSN) {
	Sentry.init({
		dsn: import.meta.env.PUBLIC_GLITCHTIP_DSN,
		tracesSampleRate: 0,
		sendDefaultPii: false,
	});
}

export const handleError = Sentry.handleErrorWithSentry();
