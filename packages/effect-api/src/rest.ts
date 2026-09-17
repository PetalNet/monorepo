import { Data, Effect, Layer, Predicate, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { invokeOperation } from "./invoke.js";
import type { ApiOperation, LogCause } from "./operation.js";
import { ApiRequest } from "./request.js";

class InvalidJson extends Data.TaggedError("InvalidJson") {}

interface RestConfig<R> {
	readonly basePath: string;
	readonly operations: readonly ApiOperation<R>[];
	readonly logCause: LogCause;
}

export const createRestLayer = <R>(config: RestConfig<R>) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const router = yield* HttpRouter.HttpRouter;
			for (const operation of config.operations) {
				yield* router.add(
					operation.method,
					`${config.basePath.replace(/\/$/, "")}${operation.path}` as `/${string}`,
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const params = yield* HttpRouter.params;
						const query = Object.fromEntries(new URL(request.originalUrl).searchParams.entries());
						const input = yield* operation.body
							? request.text.pipe(
									Effect.flatMap((text) =>
										text.length === 0
											? Effect.succeed({})
											: Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text),
									),
									Effect.mapError(() => new InvalidJson()),
								)
							: Effect.succeed({});
						const merged = Predicate.isReadonlyObject(input)
							? { ...input, ...query, ...params }
							: input;
						const current = yield* ApiRequest;
						const value = yield* invokeOperation(operation, merged, config.logCause).pipe(
							Effect.provide(current.services),
						);
						return HttpServerResponse.jsonUnsafe(value);
					}).pipe(
						Effect.catchTags({
							InvalidJson: () =>
								Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{ error: { code: "invalid_json", message: "Expected a JSON body" } },
										{ status: 400 },
									),
								),
							InvocationFailure: (failure) =>
								Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{
											error: { code: failure.code, message: failure.message },
										},
										{ status: failure.status },
									),
								),
						}),
					),
				);
			}
		}),
	);
