import { publicConfig } from "$lib/config";
import * as Sentry from "@sentry/sveltekit";

import { createCaughtFailureReporter } from "./glitchtip-reporter";

/**
 * Glitchtip is Sentry-wire-compatible; the @sentry/sveltekit SDK points at the Glitchtip DSN. Empty
 * DSN = inert (no init, no network), matching the lab's Rust dispatcher convention (GLITCHTIP_DSN
 * empty = disabled).
 */
const GLITCHTIP_DSN = publicConfig.glitchtipDsn ?? "";

const glitchtipEnabled = GLITCHTIP_DSN.length > 0;

/**
 * Report failures that a loader intentionally converts into degraded UI. Context is restricted to
 * stable surface and route-template labels; the reporter sanitizes exception messages and
 * deduplicates identical failure classes for one minute.
 */
export const captureCaughtFailure = createCaughtFailureReporter(
	(error, context) => {
		Sentry.captureException(error, {
			level: "error",
			fingerprint: [
				"console-caught-failure",
				context.surface,
				context.endpoint,
				context.errorClass,
			],
			tags: {
				"console.surface": context.surface,
				"console.endpoint": context.endpoint,
				"error.class": context.errorClass,
			},
		});
	},
	{ enabled: glitchtipEnabled },
);
