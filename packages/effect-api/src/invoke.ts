import { Cause, Effect, Exit, Schema } from "effect";

import type { ApiOperation, LogCause } from "./operation.js";

export type InvocationResult =
	| { readonly kind: "success"; readonly value: unknown }
	| {
			readonly kind: "failure";
			readonly status: number;
			readonly code: "invalid_input" | "operation_failed";
			readonly message: string;
	  };

const operationFailed = (status = 500, message = "The operation failed"): InvocationResult => ({
	kind: "failure",
	status,
	code: "operation_failed",
	message,
});

export function invokeOperation<R>(
	operation: ApiOperation<R>,
	input: unknown,
	logCause: LogCause,
): Effect.Effect<InvocationResult, never, R> {
	const decoded = Schema.decodeUnknownExit(operation.input)(input, { errors: "all" });
	if (Exit.isFailure(decoded)) {
		return Effect.succeed({
			kind: "failure",
			status: 400,
			code: "invalid_input",
			message: Cause.pretty(decoded.cause),
		});
	}
	return operation.handle(decoded.value).pipe(
		Effect.map((value): InvocationResult => ({ kind: "success", value })),
		Effect.catchCause((cause) => {
			const failures = cause.reasons.filter(Cause.isFailReason);
			const failureReason = failures[0];
			if (
				Cause.hasDies(cause) ||
				Cause.hasInterrupts(cause) ||
				failureReason === undefined ||
				failures.length !== 1
			) {
				logCause(operation.name, cause);
				return Effect.succeed(operationFailed());
			}

			const failure = failureReason.error;
			try {
				const status = operation.statusForError?.(failure) ?? 500;
				if (!Number.isInteger(status) || status < 400 || status > 599) {
					logCause(operation.name, cause);
					return Effect.succeed(operationFailed());
				}
				const message = operation.messageForError?.(failure) ?? "The operation failed";
				if (status >= 500) logCause(operation.name, cause);
				return Effect.succeed(operationFailed(status, message));
			} catch (defect) {
				logCause(operation.name, Cause.combine(cause, Cause.die(defect)));
				return Effect.succeed(operationFailed());
			}
		}),
	);
}
