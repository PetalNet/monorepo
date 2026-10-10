import type { Effect, Schema } from "effect";
import { Cause } from "effect";
import type { HttpMethod as HttpMethods } from "effect/http";

export type HttpMethod = HttpMethods.HttpMethod;

interface RestBinding {
	readonly method: HttpMethod;
	readonly path: `/${string}`;
}

export interface ApiOperation<R> {
	readonly name: string;
	readonly description: string;
	readonly rest?: RestBinding;
	readonly input: Schema.ConstraintDecoder<unknown>;
	readonly output: Schema.ConstraintCodec<unknown, unknown>;
	readonly handle: (input: unknown) => Effect.Effect<unknown, unknown, R>;
	readonly statusForError?: (error: unknown) => number;
	readonly messageForError?: (error: unknown) => string;
}

export type OperationConfig<I, A, E, R> = {
	readonly name: string;
	readonly description: string;
	readonly input: Schema.ConstraintDecoder<I>;
	readonly output: Schema.ConstraintCodec<A, unknown>;
	readonly handler: (input: I) => Effect.Effect<A, E, R>;
	readonly statusForError?: (error: E) => number;
	readonly messageForError?: (error: E) => string;
} & (RestBinding | { readonly method?: never; readonly path?: never });

export type LogCause = (operationName: string, cause: Cause.Cause<unknown>) => void;

export const defaultLogCause: LogCause = (operationName, cause) => {
	console.error(`${operationName} failed\n${Cause.pretty(cause)}`);
};

/** Declare an Effect operation. Omit method/path for MCP-only exposure. */
export function operation<I, A, E, R>(config: OperationConfig<I, A, E, R>): ApiOperation<R> {
	const declared = {
		name: config.name,
		description: config.description,
		...(config.method === undefined
			? {}
			: {
					rest: {
						method: config.method,
						path: config.path,
					},
				}),
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
