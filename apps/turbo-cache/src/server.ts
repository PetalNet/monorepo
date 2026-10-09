import { Effect } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import type { Exchanger } from "./exchanger.ts";

export const application = (exchanger: Exchanger) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const path = request.url.split("?")[0];

		if (request.method === "GET" && path === "/.well-known/jwks.json") {
			return HttpServerResponse.jsonUnsafe(exchanger.jwks);
		}

		if (request.method !== "POST" || path !== "/exchange") {
			return HttpServerResponse.empty({ status: 404 });
		}

		const token = request.headers["authorization"]?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];

		if (!token || token.length > 16_384) {
			return HttpServerResponse.empty({ status: 401 });
		}

		return yield* exchanger.exchange(token).pipe(
			Effect.map((body) =>
				HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "no-store" } }),
			),
			Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
		);
	});
