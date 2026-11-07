import { env } from "$env/dynamic/public";
import { sentryOptions } from "$lib/telemetry.js";
// Glitchtip (self-hosted Sentry) browser error reporting. PUBLIC_GLITCHTIP_DSN is dynamic
// public env, read at runtime by adapter-node and never baked into the bundle. Unset → the
// SDK stays dormant (local dev default).
import * as Sentry from "@sentry/sveltekit";

// sentryOptions strips credentials (cookies, share tokens, secret query params) from every event.
Sentry.init(
	sentryOptions({ dsn: env.PUBLIC_GLITCHTIP_DSN, environment: env.PUBLIC_GLITCHTIP_ENV }),
);

export const handleError = Sentry.handleErrorWithSentry();
