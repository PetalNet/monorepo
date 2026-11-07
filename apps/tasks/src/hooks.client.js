// Glitchtip (self-hosted Sentry) — browser-side error reporting (standing rule, task-651).
// PUBLIC_GLITCHTIP_DSN is dynamic public env: injected at RUNTIME by adapter-node from the
// service env, never baked into the bundle. Unset → SDK dormant (local dev default).
// A DSN is a submit-only key (it can only create events), but we still treat it as config,
// not source: env only, gitignored. Recipe: homelab-docs/runbooks/glitchtip.md
import * as Sentry from '@sentry/sveltekit';
import { env } from '$env/dynamic/public';

Sentry.init({
  dsn: env.PUBLIC_GLITCHTIP_DSN,
  enabled: Boolean(env.PUBLIC_GLITCHTIP_DSN),
  environment: env.PUBLIC_GLITCHTIP_ENV || 'production',
  // errors only — no perf tracing, no session replay; keep the client light
  tracesSampleRate: 0
});

export const handleError = Sentry.handleErrorWithSentry();
