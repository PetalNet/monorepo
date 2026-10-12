import { Cause, Effect, Layer, Option, Predicate, Schema, SchemaAST } from "effect";
import {
	HttpMethod,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiMiddleware,
	OpenApi,
} from "effect/http-api";

import { invokeOperation } from "./invoke.js";
import { operationErrorSchemas, type ApiOperation, type LogCause } from "./operation.js";
import { inHostRequest, type RequestMiddleware } from "./request.js";

/** Encode only the declared public fields, never the underlying failure or cause. */
export const failureResponse = ({
	status,
	message,
	code = "operation_failed",
}: {
	readonly status: number;
	readonly message: string;
	readonly code?: string;
}) => HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });

interface RestConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly basePath: `/${string}`;
	readonly openapiPath: `/${string}`;
	readonly operations: readonly ApiOperation<R>[];
	readonly restMiddleware?: RequestMiddleware;
	readonly restMiddlewareErrors?: readonly Schema.Codec<unknown>[];
	readonly logCause: LogCause;
}

const projectInput = (
	ast: SchemaAST.AST,
	pathKeys: readonly string[],
	pathTypes = new Map<string, SchemaAST.AST[]>(),
): SchemaAST.AST => {
	if (SchemaAST.isUnion(ast)) {
		return new SchemaAST.Union(
			ast.types.map((member) => projectInput(member, pathKeys, pathTypes)),
			ast.options,
		);
	}

	if (!SchemaAST.isObjects(ast)) {
		return ast;
	}

	for (const key of pathKeys) {
		const types = pathTypes.get(key) ?? [];

		types.push(
			ast.propertySignatures.find((property) => property.name === key)?.type ?? Schema.String.ast,
		);

		pathTypes.set(key, types);
	}

	return new SchemaAST.Objects(
		ast.propertySignatures.filter((property) => !pathKeys.includes(String(property.name))),
		ast.indexSignatures,
	);
};

const makeEndpoint = (
	operation: ApiOperation<unknown>,
	rest: NonNullable<ApiOperation<unknown>["rest"]>,
) => {
	if (!HttpMethod.all.has(rest.method)) {
		throw new TypeError("Unsupported HTTP method");
	}

	// Transport codecs validate the wire shape; the shared invocation decodes the
	// complete operation input, including whole-object checks and transformations.
	const input = Schema.toEncoded(operation.input);
	const pathKeys = [...rest.path.matchAll(/:[^/]+/gu)].map((match) => match[0].slice(1));
	const pathTypes = new Map<string, SchemaAST.AST[]>();
	const remaining =
		pathKeys.length > 0
			? Schema.make<Schema.Codec<unknown>>(projectInput(input.ast, pathKeys, pathTypes))
			: input;
	const params = Schema.Struct(
		Object.fromEntries(
			pathKeys.map((key) => {
				const [first = Schema.String.ast, ...others] = pathTypes.get(key) ?? [];

				return [
					key,
					Schema.make<Schema.Codec<unknown>>(
						others.length === 0 ? first : new SchemaAST.Union([first, ...others]),
					),
				];
			}),
		),
	);
	const isEmpty = (ast: SchemaAST.AST): boolean =>
		SchemaAST.isUnion(ast)
			? ast.types.every(isEmpty)
			: SchemaAST.isObjects(ast) &&
				ast.propertySignatures.length === 0 &&
				ast.indexSignatures.length === 0;

	return HttpApiEndpoint.make(rest.method)(operation.name, rest.path, {
		...(pathKeys.length > 0 ? { params } : {}),
		...(isEmpty(remaining.ast) ? {} : rest.body ? { payload: remaining } : { query: remaining }),
		success: Schema.make<Schema.Codec<unknown>>(operation.output.ast),
		error: operationErrorSchemas(operation.errors ?? {}),
	}).annotate(OpenApi.Description, operation.description);
};

/** Generate the contract and native handlers from the same operation catalog. */
export const createRestApi = <R>(config: RestConfig<R>) => {
	class OperationBoundary extends HttpApiMiddleware.Service<OperationBoundary>()(
		"@petalnet/effect-api/OperationBoundary",
		{
			error: [
				Schema.Struct({
					error: Schema.Struct({ code: Schema.Literal("invalid_input"), message: Schema.String }),
				}).annotate({ httpApiStatus: 400 }),
				Schema.Struct({
					error: Schema.Struct({
						code: Schema.Literal("operation_failed"),
						message: Schema.String,
					}),
				}).annotate({ httpApiStatus: 500 }),
				...(config.restMiddlewareErrors ?? []),
			],
		},
	) {}

	const registrations = config.operations.flatMap((operation) =>
		operation.rest ? [{ operation, endpoint: makeEndpoint(operation, operation.rest) }] : [],
	);
	const emptyGroup = HttpApiGroup.make("operations", { topLevel: true });
	const [first, ...rest] = registrations;
	// Dynamic catalogs can be empty; HttpApiGroup's endpoint parameter is invariant.
	const group = (
		first ? emptyGroup.add(first.endpoint, ...rest.map(({ endpoint }) => endpoint)) : emptyGroup
	) as HttpApiGroup.HttpApiGroup<"operations", ReturnType<typeof makeEndpoint>, true>;
	const api = HttpApi.make("effect-api")
		.add(group)
		.prefix(config.basePath)
		.middleware(OperationBoundary)
		.annotate(OpenApi.Title, config.title)
		.annotate(OpenApi.Version, config.version);
	const implementations = HttpApiBuilder.group(api, "operations", (handlers) =>
		handlers.handleAll(
			Object.fromEntries(
				registrations.map(({ operation }) => [
					operation.name,
					Effect.fnUntraced(
						function* (request: {
							readonly params?: unknown;
							readonly query?: unknown;
							readonly payload?: unknown;
							readonly request: HttpServerRequest.HttpServerRequest;
						}) {
							let input = "payload" in request ? request.payload : (request.query ?? {});
							const encoded = Schema.toEncoded(operation.input);

							// Projected union members can overlap without their path discriminator.
							// Preserve the wire input until the complete schema selects a member.
							if (request.params && SchemaAST.isUnion(encoded.ast)) {
								if ("payload" in request) {
									input = yield* request.request.json;
								} else {
									const query = yield* HttpServerRequest.ParsedSearchParams;
									const route = yield* HttpRouter.RouteContext;
									const wireSchema = Schema.toCodecArrayFromSingle(
										Schema.toCodecStringTree(
											Schema.make<Schema.Codec<unknown>>(projectInput(encoded.ast, [])),
										),
									);

									input = yield* HttpApiError.HttpApiSchemaError.wrap(
										"Query",
										Schema.decodeEffect(wireSchema)({ ...query, ...route.params }),
									);
								}
							}

							const merged = Predicate.isReadonlyObject(input)
								? {
										...input,
										...(Predicate.isReadonlyObject(request.params) ? request.params : {}),
									}
								: input;

							return yield* inHostRequest(invokeOperation(operation, merged, config.logCause)).pipe(
								Effect.catchTag("InvocationFailure", (failure) =>
									Effect.succeed(failureResponse(failure)),
								),
							);
						},
						Effect.catchTag("HttpApiSchemaError", (failure) =>
							Effect.succeed(
								failureResponse({
									code: "invalid_input",
									message: failure.cause.message,
									status: 400,
								}),
							),
						),
						Effect.orDie,
					),
				]),
			),
		),
	);
	const boundary = Layer.succeed(OperationBoundary, (httpEffect, { endpoint }) => {
		const handled = httpEffect.pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) {
					return Effect.failCause(
						Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
					);
				}

				const failure = Cause.findErrorOption(cause);

				if (
					cause.reasons.length === 1 &&
					Option.isSome(failure) &&
					HttpApiError.HttpApiSchemaError.is(failure.value) &&
					failure.value.kind !== "Body" &&
					failure.value.kind !== "ResponseHeaders"
				) {
					return Effect.succeed(
						failureResponse({
							code: "invalid_input",
							message: failure.value.cause.message,
							status: 400,
						}),
					);
				}

				config.logCause(endpoint.identifier, cause);

				return Effect.succeed(failureResponse({ message: "The operation failed", status: 500 }));
			}),
		);

		return inHostRequest(config.restMiddleware ? config.restMiddleware(handled) : handled);
	});
	const layer = HttpApiBuilder.layer(api, { openapiPath: config.openapiPath }).pipe(
		Layer.provide(implementations),
		Layer.provide(boundary),
		Layer.provide(HttpServer.layerServices),
	);

	return { api, layer };
};
