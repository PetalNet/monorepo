import { PUBLIC_GLITCHTIP_DSN, PUBLIC_GLITCHTIP_ENV } from "$app/env/public";
// Glitchtip (self-hosted Sentry) browser error reporting. PUBLIC_GLITCHTIP_DSN is dynamic
// public env, read at runtime by adapter-node and never baked into the bundle. Unset → the
// SDK stays dormant (local dev default).
import * as Sentry from "@sentry/sveltekit";

import { sentryOptions } from "#lib/telemetry.js";

// sentryOptions strips credentials (cookies, share tokens, secret query params) from every event.
Sentry.init(sentryOptions({ dsn: PUBLIC_GLITCHTIP_DSN, environment: PUBLIC_GLITCHTIP_ENV }));

export const handleError = Sentry.handleErrorWithSentry();
