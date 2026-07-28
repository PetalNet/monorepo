import { Cause, Effect, Schema } from "effect";

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface ApiOperation<R> {
	readonly name: string;
	readonly description: string;
	readonly method: HttpMethod;
	readonly path: string;
	readonly body: boolean;
	readonly input: Schema.ConstraintDecoder<unknown>;
	readonly output: Schema.Constraint;
	readonly handle: (input: unknown) => Effect.Effect<unknown, unknown, R>;
	readonly statusForError?: (error: unknown) => number;
	readonly messageForError?: (error: unknown) => string;
}

export interface OperationConfig<I, A, E, R> {
	readonly name: string;
	readonly description: string;
	readonly method: HttpMethod;
	readonly path: string;
	/** Whether REST reads the operation input from JSON. Path and query fields are always merged in. */
	readonly body?: boolean;
	readonly input: Schema.ConstraintDecoder<I>;
	readonly output: Schema.ConstraintCodec<A>;
	readonly handler: (input: I) => Effect.Effect<A, E, R>;
	readonly statusForError?: (error: E) => number;
	readonly messageForError?: (error: E) => string;
}

export type LogCause = (operationName: string, cause: Cause.Cause<unknown>) => void;

/** Declare one transport-neutral operation backed by an Effect handler. */
export function operation<I, A, E, R>(config: OperationConfig<I, A, E, R>): ApiOperation<R> {
	const declared = {
		name: config.name,
		description: config.description,
		method: config.method,
		path: config.path,
		body: config.body ?? ["PATCH", "POST", "PUT"].includes(config.method),
		input: config.input,
		output: config.output,
		handle: (input: unknown) => config.handler(input as I),
	} satisfies ApiOperation<R>;
	return {
		...declared,
		...(config.statusForError
			? { statusForError: config.statusForError as (error: unknown) => number }
			: {}),
		...(config.messageForError
			? { messageForError: config.messageForError as (error: unknown) => string }
			: {}),
	};
}
