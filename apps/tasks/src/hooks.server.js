// Glitchtip (self-hosted Sentry) error reporting. The DSN comes only from env
// (GLITCHTIP_DSN); unset → the SDK stays dormant (local dev default).
import * as Sentry from "@sentry/sveltekit";
import { sequence } from "@sveltejs/kit/hooks";

import { tasksConfig } from "./lib/server/config.js";

Sentry.init({
	dsn: process.env.GLITCHTIP_DSN,
	enabled: Boolean(process.env.GLITCHTIP_DSN),
	environment: process.env.GLITCHTIP_ENV || "production",
	// errors only — no perf tracing
	tracesSampleRate: 0,
});

// Identity + access gate. Behind Authentik forward-auth, traefik injects X-authentik-username.
// ALLOW (Authentik usernames) is the access list. With ALLOW set (production) we FAIL CLOSED:
// a missing/unknown header is rejected, never silently treated as the 'dev' identity. The
// 'dev' fallback exists ONLY for local dev where no ALLOW is configured.
const ALLOW = (process.env.ALLOW || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

// PUBLIC scoped-share exemption (/s/<token>, the #487 feature): /s/ is the ONE SSO-exempt path.
// Traefik already strips the Authentik forward-auth middleware for PathPrefix `/s/` (see
// Reverse proxy configuration router `tasks-share`), so this gate must NOT re-reject a
// /s/ request for lacking an identity. The /s/ handler (src/routes/s/[token]/+server.js) is
// fail-closed, read-only, and token-scoped to a single artifact, so ALL access control lives there.
// Strict exact-prefix match — exactly `/s` or `/s/…`, nothing else can ride the exemption.
const isPublicShare = (pathname) => pathname === "/s" || pathname.startsWith("/s/");

// AGENT-API exemption (/api/agent/rpc): same rationale as /s/ — Traefik must ALSO strip the
// Authentik forward-auth middleware for PathPrefix('/api/agent/') (an agent adds the `tasks-agent`
// router), and this gate must not re-403 the identity-less request. Safe because the endpoint
// (src/routes/api/agent/rpc/+server.js) is FAIL-CLOSED by bearer token: no valid unrevoked
// token → 401, and a scoped token is confined to its own assignee/project lane. Same strict
// exact-prefix match as /s/; event.locals.user is intentionally left unset on this path —
// the endpoint resolves identity by token, never by header.
const isAgentApi = (pathname) => pathname === "/api/agent" || pathname.startsWith("/api/agent/");

async function accessGate({ event, resolve }) {
	const user = event.request.headers.get("x-authentik-username") || "";

	if (ALLOW.length > 0 && !isPublicShare(event.url.pathname) && !isAgentApi(event.url.pathname)) {
		// production: require a valid Authentik identity (fail closed — was fail-open via 'dev')
		if (!user || !ALLOW.includes(user)) {
			return new Response(tasksConfig.accessMessage ?? "Access denied.", {
				status: 403,
				headers: { "content-type": "text/plain" },
			});
		}

		event.locals.user = user;
	} else if (ALLOW.length === 0) {
		// local dev only (no access list): permit the dev fallback identity
		event.locals.user = user || "dev";
	}

	// production + /s/ public share: no identity required; event.locals.user intentionally left
	// unset — the share route resolves strictly by token, never by user.
	// Theme: paper-and-ink IS the base theme now (the only theme — legacy dark-zinc/amber
	// dropped, an operator). No skin class to tag; the tokens live unconditionally in app.css.
	const res = await resolve(event);

	// defense-in-depth headers (sanitizer is the primary XSS line; these harden the rest).
	// Use the no-clobber form: a route may legitimately need to relax a header for itself
	// (e.g. the gallery raw-artifact endpoint frames its own same-origin sandbox iframe, so
	// it sets X-Frame-Options: SAMEORIGIN + a CSP sandbox). Only fill in defaults it left unset.
	if (!res.headers.has("X-Frame-Options")) {
		res.headers.set("X-Frame-Options", "DENY");
	} // clickjacking

	res.headers.set("X-Content-Type-Options", "nosniff");

	if (!res.headers.has("Referrer-Policy")) {
		res.headers.set("Referrer-Policy", "same-origin");
	}

	return res;
}

export const handle = sequence(Sentry.sentryHandle(), accessGate);

// Unexpected server errors → Glitchtip. Expected errors (kit's error(status, ...)) are
// NOT reported — that's the SDK default and exactly what we want for the 403/404 paths.
export const handleError = Sentry.handleErrorWithSentry();
