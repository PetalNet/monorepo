import type { Effect, Schema } from "effect";
import { Cause } from "effect";
import { HttpMethod as HttpMethods, type HttpRouter } from "effect/http";

export type HttpMethod = Exclude<Parameters<HttpRouter.HttpRouter["add"]>[0], "*">;

interface RestBinding {
	readonly method: HttpMethod;
	readonly path: `/${string}`;
	/** Use a JSON payload instead of query fields. Defaults to the HTTP method's body policy. */
	readonly body?: boolean;
}

export interface OperationError<E = unknown> {
	readonly status: number;
	readonly message?: string | ((error: E) => string);
}

export type OperationErrors<E> = {
	readonly [Tag in E extends { readonly _tag: infer ErrorTag extends string }
		? ErrorTag
		: never]: OperationError<Extract<E, { readonly _tag: Tag }>>;
};

export interface ApiOperation<R> {
	readonly name: string;
	readonly description: string;
	readonly rest?: Required<RestBinding>;
	readonly input: Schema.ConstraintDecoder<unknown>;
	readonly output: Schema.ConstraintCodec<unknown, unknown>;
	readonly handle: (input: unknown) => Effect.Effect<unknown, unknown, R>;
	readonly errors?: Readonly<Record<string, OperationError>>;
}

export type OperationConfig<I, A, E, R> = {
	readonly name: string;
	readonly description: string;
	readonly input: Schema.ConstraintDecoder<I>;
	readonly output: Schema.ConstraintCodec<A, unknown>;
	readonly handler: (input: I) => Effect.Effect<A, E, R>;
	readonly errors?: OperationErrors<E>;
} & (RestBinding | { readonly method?: never; readonly path?: never; readonly body?: never });

export type LogCause = (operationName: string, cause: Cause.Cause<unknown>) => void;

export const defaultLogCause: LogCause = (operationName, cause) => {
	console.error(`${operationName} failed\n${Cause.pretty(cause)}`);
};

/** Declare an Effect operation. Omit method/path for MCP-only exposure. */
export function operation<I, A, E, R>(config: OperationConfig<I, A, E, R>): ApiOperation<R> {
	for (const error of Object.values(config.errors ?? {}) as readonly OperationError[]) {
		if (!Number.isInteger(error.status) || error.status < 400 || error.status > 599) {
			throw new TypeError("Operation error status must be an integer between 400 and 599");
		}
	}

	const declared = {
		name: config.name,
		description: config.description,
		...(config.method === undefined
			? {}
			: {
					rest: {
						method: config.method,
						path: config.path,
						body: config.body ?? HttpMethods.hasBody(config.method),
					},
				}),
		input: config.input,
		output: config.output,
		handle: (input: unknown) => config.handler(input as I),
	} satisfies ApiOperation<R>;

	return {
		...declared,
		...(config.errors ? { errors: config.errors as Readonly<Record<string, OperationError>> } : {}),
	};
}
