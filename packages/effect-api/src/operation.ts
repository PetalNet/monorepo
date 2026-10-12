import type { Effect } from "effect";
import { Cause, Schema } from "effect";
import { HttpMethod as HttpMethods, type HttpRouter } from "effect/http";

export type HttpMethod = Exclude<Parameters<HttpRouter.HttpRouter["add"]>[0], "*">;

interface RestBinding {
	readonly method: HttpMethod;
	readonly path: `/${string}`;
	/** Use a JSON payload instead of query fields. Defaults to the HTTP method's body policy. */
	readonly body?: boolean;
}

export interface OperationError {
	readonly status: number;
	readonly message?: string;
	readonly map: (error: unknown) => { status: number; message: string; log: boolean } | undefined;
}

export type OperationErrors = readonly OperationError[];

/** Bind a public failure policy to a schema that narrows its message callback input. */
export const operationError = <E>(
	schema: Schema.ConstraintDecoder<E>,
	config: { readonly status: number; readonly message?: string | ((error: E) => string) },
): OperationError => {
	const { status, message } = config;

	if (!Number.isInteger(status) || status < 400 || status > 599) {
		throw new TypeError("Operation error status must be an integer between 400 and 599");
	}

	const is = Schema.is(schema);

	return {
		status,
		...(typeof message === "string" ? { message } : {}),
		map: (error) =>
			is(error)
				? {
						status,
						message:
							typeof message === "function" ? message(error) : (message ?? "The operation failed"),
						log: status >= 500,
					}
				: undefined,
	};
};

/** Native response contracts for declared public operation or authentication failures. */
export const operationErrorSchemas = (errors: OperationErrors) =>
	errors.map(({ status, message }) =>
		Schema.Struct({
			error: Schema.Struct({
				code: Schema.Literal("operation_failed"),
				message: typeof message === "string" ? Schema.Literal(message) : Schema.String,
			}),
		}).annotate({ httpApiStatus: status }),
	);

/** Resolve declared public failures without exposing unknown errors. */
export const mapOperationErrors = (errors: OperationErrors) => (error: unknown) => {
	for (const declaration of errors) {
		const mapped = declaration.map(error);

		if (mapped) {
			return mapped;
		}
	}

	return undefined;
};

export interface ApiOperation<R> {
	readonly name: string;
	readonly description: string;
	readonly rest?: Required<RestBinding>;
	readonly input: Schema.ConstraintDecoder<unknown>;
	readonly output: Schema.ConstraintCodec<unknown, unknown>;
	readonly handle: (input: unknown) => Effect.Effect<unknown, unknown, R>;
	readonly errors?: OperationErrors;
}

export type OperationConfig<I, A, E, R> = {
	readonly name: string;
	readonly description: string;
	readonly input: Schema.ConstraintDecoder<I>;
	readonly output: Schema.ConstraintCodec<A, unknown>;
	readonly handler: (input: I) => Effect.Effect<A, E, R>;
	readonly errors?: OperationErrors;
} & (RestBinding | { readonly method?: never; readonly path?: never; readonly body?: never });

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
						body: config.body ?? HttpMethods.hasBody(config.method),
					},
				}),
		input: config.input,
		output: config.output,
		handle: (input: unknown) => config.handler(input as I),
	} satisfies ApiOperation<R>;

	return {
		...declared,
		...(config.errors ? { errors: config.errors } : {}),
	};
}
