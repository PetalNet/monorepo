import * as Sentry from "@sentry/node";

export interface ExceptionMonitor {
	captureException(error: unknown): void;
	close(timeoutMs?: number): Promise<boolean>;
}

const INERT: ExceptionMonitor = {
	captureException() {},
	async close() {
		return true;
	},
};

/** GlitchTip speaks the Sentry protocol. No DSN means deliberately inert local/test behavior. */
export function initExceptionMonitor(dsn: string | null): ExceptionMonitor {
	if (!dsn) return INERT;
	Sentry.init({
		dsn,
		sendDefaultPii: false,
		tracesSampleRate: 0,
		beforeSend(event) {
			// Contract: exception class + sanitized stack only. Request data can echo bearer tokens,
			// query values, terminal input, or LLM prompts through framework integrations/breadcrumbs.
			delete event.request;
			delete event.user;
			delete event.extra;
			delete event.breadcrumbs;
			return event;
		},
	});
	return {
		captureException(error) {
			Sentry.captureException(error);
		},
		close(timeoutMs = 2000) {
			return Sentry.close(timeoutMs);
		},
	};
}

export const inertExceptionMonitor = INERT;

export function sanitizedException(error: unknown, message = "console-api request failed"): Error {
	const safe = new Error(message);
	safe.name = error instanceof Error ? error.constructor.name : "UnknownError";
	return safe;
}

/** Always-visible, secret-free fallback for failures that cannot be written to the lake itself. */
export function reportSelfEmissionFailure(
	monitor: ExceptionMonitor,
	error: unknown,
	reason: "rejected" | "failed",
	write: (line: string) => unknown = (line) => process.stderr.write(line),
): void {
	monitor.captureException(sanitizedException(error, `self emission ${reason}`));
	write(
		`${JSON.stringify({
			level: "error",
			service: "console-api",
			event: `self_emission_${reason}`,
			error_class: error instanceof Error ? error.constructor.name : "UnknownError",
		})}\n`,
	);
}
