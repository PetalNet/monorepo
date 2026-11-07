import { env } from "$env/dynamic/public";
// Glitchtip (self-hosted Sentry) browser error reporting. PUBLIC_GLITCHTIP_DSN is dynamic
// public env, read at runtime by adapter-node and never baked into the bundle. Unset → the
// SDK stays dormant (local dev default).
import * as Sentry from "@sentry/sveltekit";

Sentry.init({
	dsn: env.PUBLIC_GLITCHTIP_DSN,
	enabled: Boolean(env.PUBLIC_GLITCHTIP_DSN),
	environment: env.PUBLIC_GLITCHTIP_ENV || "production",
	// errors only — no perf tracing, no session replay; keep the client light
	tracesSampleRate: 0,
});

export const handleError = Sentry.handleErrorWithSentry();
