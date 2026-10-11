import { Cause, Effect, Layer, Option, Predicate, Schema, SchemaAST } from "effect";
import { HttpMethod, HttpServer, HttpServerResponse } from "effect/http";
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
import type { ApiOperation, LogCause } from "./operation.js";
import { inHostRequest, type RequestMiddleware } from "./request.js";

interface RestConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly basePath: string;
	readonly openapiPath: `/${string}`;
	readonly operations: readonly ApiOperation<R>[];
	readonly restMiddleware?: RequestMiddleware;
	readonly logCause: LogCause;
}

class OperationBoundary extends HttpApiMiddleware.Service<OperationBoundary>()(
	"@petalnet/effect-api/OperationBoundary",
	{
		error: [
			Schema.Struct({
				error: Schema.Struct({ code: Schema.Literal("invalid_input"), message: Schema.String }),
			}).annotate({ httpApiStatus: 400 }),
			Schema.Struct({
				error: Schema.Struct({ code: Schema.Literal("operation_failed"), message: Schema.String }),
			}).annotate({ httpApiStatus: 500 }),
		],
	},
) {}

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
	const project = (ast: SchemaAST.AST): SchemaAST.AST => {
		if (SchemaAST.isUnion(ast)) {
			return new SchemaAST.Union(ast.types.map(project), ast.options);
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

	const remaining =
		pathKeys.length > 0 ? Schema.make<Schema.Codec<unknown>>(project(input.ast)) : input;
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
		error: Object.values(operation.errors ?? {}).map(({ status, message }) =>
			Schema.Struct({
				error: Schema.Struct({
					code: Schema.Literal("operation_failed"),
					message: typeof message === "string" ? Schema.Literal(message) : Schema.String,
				}),
			}).annotate({ httpApiStatus: status }),
		),
	}).annotate(OpenApi.Description, operation.description);
};

/** Generate the contract and native handlers from the same operation catalog. */
export const createRestApi = <R>(config: RestConfig<R>) => {
	const registrations = config.operations.flatMap((operation) =>
		operation.rest ? [{ operation, endpoint: makeEndpoint(operation, operation.rest) }] : [],
	);
	const emptyGroup = HttpApiGroup.make("operations", { topLevel: true });
	const [first, ...rest] = registrations;
	const group = (
		first ? emptyGroup.add(first.endpoint, ...rest.map(({ endpoint }) => endpoint)) : emptyGroup
	) as HttpApiGroup.HttpApiGroup<"operations", ReturnType<typeof makeEndpoint>, true>;
	const api = HttpApi.make("effect-api")
		.add(group)
		.prefix(config.basePath.replace(/\/$/u, "") as `/${string}`)
		.middleware(OperationBoundary)
		.annotate(OpenApi.Title, config.title)
		.annotate(OpenApi.Version, config.version);
	const implementations = HttpApiBuilder.group(api, "operations", (handlers) =>
		handlers.handleAll(
			Object.fromEntries(
				registrations.map(({ operation }) => [
					operation.name,
					Effect.fnUntraced(function* (request: {
						readonly params?: unknown;
						readonly query?: unknown;
						readonly payload?: unknown;
					}) {
						const input = "payload" in request ? request.payload : (request.query ?? {});
						const merged = Predicate.isReadonlyObject(input)
							? { ...input, ...(Predicate.isReadonlyObject(request.params) ? request.params : {}) }
							: input;

						return yield* inHostRequest(invokeOperation(operation, merged, config.logCause)).pipe(
							Effect.catchTag("InvocationFailure", (failure) =>
								Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{ error: { code: failure.code, message: failure.message } },
										{ status: failure.status },
									),
								),
							),
						);
					}),
				]),
			),
		),
	);
	const boundary = Layer.succeed(OperationBoundary, (httpEffect, { endpoint }) => {
		const handled = httpEffect.pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) {
					return Effect.failCause(cause as Cause.Cause<never>);
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
						HttpServerResponse.jsonUnsafe(
							{ error: { code: "invalid_input", message: failure.value.cause.message } },
							{ status: 400 },
						),
					);
				}

				config.logCause(endpoint.identifier, cause);

				return Effect.succeed(
					HttpServerResponse.jsonUnsafe(
						{ error: { code: "operation_failed", message: "The operation failed" } },
						{ status: 500 },
					),
				);
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
