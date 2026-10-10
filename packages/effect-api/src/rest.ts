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
import { ApiRequest } from "./request.js";

interface RestConfig {
	readonly title: string;
	readonly version: string;
	readonly basePath: string;
	readonly openapiPath: `/${string}`;
	readonly operations: readonly ApiOperation<unknown>[];
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
	const ast = input.ast;
	const properties = SchemaAST.isObjects(ast) ? ast.propertySignatures : [];
	const params = Schema.Struct(
		Object.fromEntries(
			pathKeys.map((key) => [
				key,
				Schema.make<Schema.Codec<unknown>>(
					properties.find((property) => property.name === key)?.type ?? Schema.String.ast,
				),
			]),
		),
	);
	const remaining =
		pathKeys.length > 0 && SchemaAST.isObjects(ast)
			? Schema.make<Schema.Codec<unknown>>(
					new SchemaAST.Objects(
						properties.filter((property) => !pathKeys.includes(String(property.name))),
						ast.indexSignatures,
					),
				)
			: input;
	const empty =
		SchemaAST.isObjects(remaining.ast) &&
		remaining.ast.propertySignatures.length === 0 &&
		remaining.ast.indexSignatures.length === 0;

	return HttpApiEndpoint.make(rest.method)(operation.name, rest.path, {
		...(pathKeys.length > 0 ? { params } : {}),
		...(empty
			? {}
			: HttpMethod.hasBody(rest.method)
				? { payload: remaining }
				: { query: remaining }),
		success: Schema.make<Schema.Codec<unknown>>(operation.output.ast),
	}).annotate(OpenApi.Description, operation.description);
};

/** Generate the contract and native handlers from the same operation catalog. */
export const createRestApi = (config: RestConfig) => {
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
						const current = yield* Effect.serviceOption(ApiRequest);

						if (Option.isNone(current)) {
							return yield* Effect.die("Missing API request context");
						}

						const input = "payload" in request ? request.payload : (request.query ?? {});
						const merged = Predicate.isReadonlyObject(input)
							? { ...input, ...(Predicate.isReadonlyObject(request.params) ? request.params : {}) }
							: input;

						return yield* invokeOperation(operation, merged, config.logCause).pipe(
							Effect.provide(current.value.services),
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
	const boundary = Layer.succeed(OperationBoundary, (httpEffect, { endpoint }) =>
		httpEffect.pipe(
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
		),
	);
	const layer = HttpApiBuilder.layer(api, { openapiPath: config.openapiPath }).pipe(
		Layer.provide(implementations),
		Layer.provide(boundary),
		Layer.provide(HttpServer.layerServices),
	);

	return { api, layer };
};
