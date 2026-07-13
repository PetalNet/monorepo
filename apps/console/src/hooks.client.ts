import { handleErrorWithSentry } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";
import { glitchtipEnabled, sentryOptions } from "$lib/glitchtip";

if (glitchtipEnabled) {
	Sentry.init(sentryOptions);
}

export const handleError = handleErrorWithSentry();
