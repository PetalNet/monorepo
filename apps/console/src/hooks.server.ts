import { glitchtipEnabled, sentryOptions } from "$lib/glitchtip";
import { handleErrorWithSentry, sentryHandle } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";
import { sequence } from "@sveltejs/kit/hooks";

if (glitchtipEnabled) {
	Sentry.init(sentryOptions);
}

export const handle = sequence(sentryHandle());
export const handleError = handleErrorWithSentry();
