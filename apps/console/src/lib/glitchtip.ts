import { env } from "$env/dynamic/public";

/**
 * Glitchtip is Sentry-wire-compatible; the @sentry/sveltekit SDK points at the Glitchtip DSN. Empty
 * DSN = inert (no init, no network), matching the lab's Rust dispatcher convention (GLITCHTIP_DSN
 * empty = disabled).
 */
const GLITCHTIP_DSN = env.PUBLIC_GLITCHTIP_DSN ?? "";

export const sentryOptions = {
	dsn: GLITCHTIP_DSN,
	// Glitchtip ignores traces; keep it light. Errors are the contract (see
	// CONSOLE-CONTRACTS.md section 10: Glitchtip carries exceptions, the lake
	// carries events — one error, both places, by class not duplication).
	tracesSampleRate: 0,
	sendDefaultPii: false,
};

export const glitchtipEnabled = GLITCHTIP_DSN.length > 0;
