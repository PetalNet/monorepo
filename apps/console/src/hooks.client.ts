import { glitchtipEnabled, sentryOptions } from "$lib/glitchtip";
import { handleErrorWithSentry } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";

if (glitchtipEnabled) {
	Sentry.init(sentryOptions);
}

export const handleError = handleErrorWithSentry();
