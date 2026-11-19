import { readFileSync } from "node:fs";

import { Config, Context, Data, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class MatrixNotConfigured extends Data.TaggedError("MatrixNotConfigured") {}

export class MatrixUnavailable extends Data.TaggedError("MatrixUnavailable")<{
	readonly cause: unknown;
}> {}

export type MatrixError = MatrixNotConfigured | MatrixUnavailable;

/** Posts one plain-text message into the gallery room and returns its event id. */
export class MatrixPoster extends Context.Service<
	MatrixPoster,
	{ readonly post: (text: string) => Effect.Effect<string, MatrixError> }
>()("tasks/MatrixPoster") {}

const Sent = Schema.Struct({ event_id: Schema.String });

const send = (homeserver: string, room: string, tokenFile: string, text: string) =>
	Effect.gen(function* () {
		const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
		const token = (yield* Effect.try({
			try: () => readFileSync(tokenFile, "utf8"),
			catch: (cause) => new MatrixUnavailable({ cause }),
		})).trim();
		const url = `${homeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`;

		return yield* HttpClientRequest.put(url).pipe(
			HttpClientRequest.bearerToken(token),
			HttpClientRequest.bodyJson({ msgtype: "m.text", body: text }),
			Effect.flatMap((request) => client.execute(request)),
			Effect.flatMap(HttpClientResponse.schemaBodyJson(Sent)),
			Effect.mapBoth({
				onSuccess: (sent) => sent.event_id,
				onFailure: (cause) => new MatrixUnavailable({ cause }),
			}),
		);
	});

/**
 * The real poster. MATRIX_HOMESERVER and MATRIX_ROOM name the unencrypted room; MATRIX_TOKEN_FILE
 * is read on every post so a rotated token needs no restart. Without all three the layer still
 * builds and every post fails with MatrixNotConfigured.
 */
export const MatrixPosterLive = Layer.effect(
	MatrixPoster,
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient;
		const homeserver = yield* Config.option(Config.String("MATRIX_HOMESERVER"));
		const room = yield* Config.option(Config.String("MATRIX_ROOM"));
		const tokenFile = yield* Config.option(Config.String("MATRIX_TOKEN_FILE"));

		return MatrixPoster.of({
			post: (text) =>
				Effect.gen(function* () {
					if (Option.isNone(homeserver) || Option.isNone(room) || Option.isNone(tokenFile)) {
						return yield* new MatrixNotConfigured();
					}

					return yield* send(homeserver.value, room.value, tokenFile.value, text).pipe(
						Effect.provideService(HttpClient.HttpClient, http),
					);
				}),
		});
	}),
);
