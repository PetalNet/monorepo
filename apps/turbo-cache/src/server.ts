import { Effect } from "effect";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import type { Exchanger } from "./exchanger.ts";
import { homeHeaders, renderHome, renderLive, type HomeData } from "./home.ts";
import { parseEvents, readStorage, type createEventCounter } from "./stats.ts";

export interface Site {
	readonly build: string;
	/** Base URL of the ducktors cache server behind the exchanger. */
	readonly cacheUrl: string;
	readonly storageFile: string;
	readonly events: ReturnType<typeof createEventCounter>;
	/** Self-hosted woff2 files by asset name, for example "geist" and "geist-mono". */
	readonly fonts: Readonly<Record<string, Uint8Array>>;
	readonly now?: () => number;
}

const eventsPath = "/v8/artifacts/events";
const maxEventsBody = 1_048_576;

export const application = (exchanger: Exchanger, site?: Site) => {
	let upstream = { at: 0, up: false };

	const cacheUp = async (cacheUrl: string, now: number) => {
		if (now - upstream.at > 10_000) {
			const up = await fetch(`${cacheUrl}/v8/artifacts/status`, {
				signal: AbortSignal.timeout(1500),
			}).then(
				(response) => response.ok,
				() => false,
			);

			upstream = { at: now, up };
		}

		return upstream.up;
	};

	const view = async (shown: Site): Promise<HomeData> => {
		const now = (shown.now ?? Date.now)();

		return {
			now,
			cacheUp: await cacheUp(shown.cacheUrl, now),
			storage: await readStorage(shown.storageFile),
			events: shown.events.snapshot(),
			build: shown.build,
		};
	};

	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const path = request.url.split("?")[0];

		if (request.method === "GET" && path === "/.well-known/jwks.json") {
			return HttpServerResponse.jsonUnsafe(exchanger.jwks);
		}

		if (site && request.method === "GET" && path === "/") {
			const data = yield* Effect.promise(() => view(site));

			return HttpServerResponse.text(renderHome(data), {
				contentType: "text/html; charset=utf-8",
				headers: homeHeaders,
			});
		}

		if (site && request.method === "GET" && path === "/_live") {
			const data = yield* Effect.promise(() => view(site));

			return HttpServerResponse.text(renderLive(data), {
				contentType: "text/html; charset=utf-8",
				headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
			});
		}

		if (site && request.method === "GET" && path === "/stats.json") {
			const { storage, events, cacheUp: up } = yield* Effect.promise(() => view(site));

			return HttpServerResponse.jsonUnsafe(
				{ cache_up: up, storage, events },
				{ headers: { "cache-control": "no-store" } },
			);
		}

		const font = path?.match(/^\/assets\/([a-z-]+)\.woff2$/)?.[1];

		if (site && request.method === "GET" && font !== undefined && Object.hasOwn(site.fonts, font)) {
			return HttpServerResponse.uint8Array(site.fonts[font] ?? new Uint8Array(), {
				contentType: "font/woff2",
				headers: { "cache-control": "public, max-age=31536000, immutable" },
			});
		}

		// Turbo reports each remote lookup here. The request goes to ducktors unchanged, and
		// only an answer of success (so an authenticated caller) is counted.
		if (site && request.method === "POST" && path === eventsPath) {
			if (Number(request.headers["content-length"] ?? 0) > maxEventsBody) {
				return HttpServerResponse.empty({ status: 413 });
			}

			// The size limit also covers chunked bodies, which carry no content-length.
			const body = yield* request.text.pipe(
				Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxEventsBody)),
				Effect.orElseSucceed(() => null),
			);

			if (body === null || body.length > maxEventsBody) {
				return HttpServerResponse.empty({ status: 400 });
			}

			const headers = new Headers();

			for (const name of ["authorization", "content-type"]) {
				const value = request.headers[name];

				if (value) {
					headers.set(name, value);
				}
			}

			const answer = yield* Effect.tryPromise(async () => {
				const response = await fetch(`${site.cacheUrl}${request.url}`, {
					method: "POST",
					headers,
					body,
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				});

				return { response, text: await response.text() };
			}).pipe(Effect.orElseSucceed(() => null));

			if (answer === null) {
				return HttpServerResponse.empty({ status: 502 });
			}

			if (answer.response.ok) {
				site.events.record(parseEvents(body));
			}

			return HttpServerResponse.text(answer.text, {
				status: answer.response.status,
				contentType: answer.response.headers.get("content-type") ?? "application/json",
			});
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
};
