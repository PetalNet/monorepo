import { Cause, Data, Effect, Schema } from "effect";

import { mapOperationErrors, type ApiOperation, type LogCause } from "./operation.js";

export class InvocationFailure extends Data.TaggedError("InvocationFailure")<{
	readonly status: number;
	readonly code: "invalid_input" | "operation_failed";
	readonly message: string;
}> {}

const operationFailed = (status = 500, message = "The operation failed") =>
	new InvocationFailure({ status, code: "operation_failed", message });

const handleCause = Effect.fnUntraced(function* <R>(
	operation: ApiOperation<R>,
	logCause: LogCause,
	phase: "input" | "handler" | "output",
	cause: Cause.Cause<unknown>,
): Effect.fn.Return<never, InvocationFailure> {
	// Pure interruption is control flow, not a public operation failure.
	if (Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)) {
		return yield* Effect.failCause(cause as Cause.Cause<never>);
	}

	const failures = cause.reasons.filter(Cause.isFailReason);
	const failure = failures[0];

	if (!Cause.hasDies(cause) && !Cause.hasInterrupts(cause) && failures.length === 1 && failure) {
		if (phase === "input" && Schema.isSchemaError(failure.error)) {
			return yield* new InvocationFailure({
				status: 400,
				code: "invalid_input",
				message: failure.error.message,
			});
		}

		if (phase === "handler") {
			const mapped = yield* Effect.sync(() => {
				const exposed = mapOperationErrors(operation.errors ?? {})(failure.error);

				return exposed ? operationFailed(exposed.status, exposed.message) : operationFailed();
			}).pipe(
				Effect.catchCause((mapperCause) => {
					logCause(operation.name, Cause.combine(cause, mapperCause));

					return Effect.fail(operationFailed());
				}),
			);

			if (mapped.status >= 500) {
				logCause(operation.name, cause);
			}

			return yield* mapped;
		}
	}

	logCause(operation.name, cause);

	return yield* operationFailed();
});

export const invokeOperation = Effect.fnUntraced(function* <R>(
	operation: ApiOperation<R>,
	input: unknown,
	logCause: LogCause,
): Effect.fn.Return<unknown, InvocationFailure, R> {
	const decoded = yield* Effect.suspend(() =>
		Schema.decodeUnknownEffect(operation.input)(input, { errors: "all" }),
	).pipe(Effect.catchCause((cause) => handleCause(operation, logCause, "input", cause)));
	const value = yield* Effect.suspend(() => operation.handle(decoded)).pipe(
		Effect.catchCause((cause) => handleCause(operation, logCause, "handler", cause)),
	);

	// Handlers return decoded values: validate the type side without replaying transformations.
	yield* Effect.suspend(() =>
		Schema.decodeUnknownEffect(Schema.toType(operation.output))(value, { errors: "all" }),
	).pipe(Effect.catchCause((cause) => handleCause(operation, logCause, "output", cause)));

	return value;
});
