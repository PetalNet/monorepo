export type CaughtFailureSurface =
	| "cockpit-shell"
	| "cockpit"
	| "network"
	| "updates"
	| "observability";

export type CaughtFailureEndpoint =
	| "/attention"
	| "/box-updates"
	| "/box-updates/:box_id/raw"
	| "/catalog"
	| "/dashboards"
	| "/edge/sessions"
	| "/executors"
	| "/health"
	| "/me"
	| "/network/key-ceremony"
	| "/roster"
	| `/query/${"events" | "freshness" | "queries" | "emitters"}`;

export interface CaughtFailureContext {
	/** Stable UI surface name; never include user or resource identifiers. */
	readonly surface: CaughtFailureSurface;
	/** Route-template form, for example `/box-updates/:box_id/raw`. */
	readonly endpoint: CaughtFailureEndpoint;
}

export interface SanitizedCaughtFailure extends CaughtFailureContext {
	readonly errorClass: string;
}

export type CaptureCaughtFailure = (error: Error, context: SanitizedCaughtFailure) => void;

const DEDUPE_WINDOW_MS = 60_000;
const MAX_DEDUPE_KEYS = 128;

function safeErrorClass(error: unknown): string {
	const candidate = error instanceof Error ? error.constructor.name : "NonErrorThrown";
	return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(candidate) ? candidate : "Error";
}

/**
 * Builds the caught-failure reporter independently from the SDK so its privacy and dedupe contract
 * can be tested without initializing GlitchTip. The original exception is deliberately not sent:
 * API messages and URLs may contain scoped identifiers or response data.
 */
export function createCaughtFailureReporter(
	capture: CaptureCaughtFailure,
	options: { enabled: boolean; now?: () => number },
): (error: unknown, context: CaughtFailureContext) => boolean {
	const recentlyCaptured = new Map<string, number>();
	const now = options.now ?? Date.now;

	return (error, context) => {
		if (!options.enabled) return false;
		const errorClass = safeErrorClass(error);
		const key = `${context.surface}\u0000${context.endpoint}\u0000${errorClass}`;
		const capturedAt = now();
		const previous = recentlyCaptured.get(key);
		if (previous !== undefined && capturedAt - previous < DEDUPE_WINDOW_MS) return false;

		recentlyCaptured.set(key, capturedAt);
		if (recentlyCaptured.size > MAX_DEDUPE_KEYS) {
			for (const [candidate, timestamp] of recentlyCaptured) {
				if (capturedAt - timestamp >= DEDUPE_WINDOW_MS) recentlyCaptured.delete(candidate);
			}
			if (recentlyCaptured.size > MAX_DEDUPE_KEYS)
				recentlyCaptured.delete(recentlyCaptured.keys().next().value as string);
		}

		const sanitized = new Error(`Console read failed: ${context.endpoint}`);
		sanitized.name = errorClass;
		capture(sanitized, { ...context, errorClass });
		return true;
	};
}
