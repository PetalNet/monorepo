import { createHash, timingSafeEqual } from "node:crypto";

import { operation, operationError } from "@petalnet/effect-api";
import { createServer, SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Data, Effect, Layer, Schema } from "effect";

import { saveSnapshot } from "./snapshot.ts";

class Unauthorized extends Data.TaggedError("Unauthorized") {}
class InvalidSnapshot extends Data.TaggedError("InvalidSnapshot") {}
class StaleSnapshot extends Data.TaggedError("StaleSnapshot") {}

export function authorized(request: Request): boolean {
	const secret = process.env.TASKS_AGENTS_INGEST_TOKEN;
	const authorization = request.headers.get("authorization") ?? "";

	if (!secret || !authorization.startsWith("Bearer ")) return false;

	const hash = (value: string) => createHash("sha256").update(value).digest();

	return timingSafeEqual(hash(authorization.slice(7)), hash(secret));
}

const ingest = operation({
	name: "agents.ingest",
	description: "Replace the routed agents snapshot.",
	method: "POST",
	path: "/snapshot",
	input: Schema.Struct({ updatedAt: Schema.String, runs: Schema.Array(Schema.Unknown) }),
	output: Schema.Struct({}),
	handler: (input) => Effect.gen(function* () {
		const result = saveSnapshot(input);

		if (result === "invalid") return yield* new InvalidSnapshot();

		if (result === "stale") return yield* new StaleSnapshot();

		return {};
	}),
	errors: {
		InvalidSnapshot: operationError(InvalidSnapshot, { status: 400, message: "Invalid snapshot" }),
		StaleSnapshot: operationError(StaleSnapshot, { status: 409, message: "Snapshot is not newer" }),
	},
});

export const agentsApi = createServer({
	title: "Agents ingest", version: "1.0.0", basePath: "/api/agent/agents", operations: [ingest],
	services: Layer.empty,
	auth: {
		browser: Effect.gen(function* () {
			const event = yield* SvelteKitRequestEvent;

			if (!authorized(event.request)) return yield* new Unauthorized();

			return Context.empty();
		}),
		errors: { Unauthorized: operationError(Unauthorized, { status: 401, message: "Authentication required" }) },
		mcp: false,
	},
});

const maxBytes = 4 * 1024 * 1024;

/** Only this method and path bypass the browser identity gate. */
export async function ingestRequest(event: import("@sveltejs/kit").RequestEvent): Promise<Response> {
	if (event.request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

	if (!authorized(event.request)) return new Response(null, { status: 401 });

	const reader = event.request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	if (reader) {
		while (true) {
			const { done, value } = await reader.read();

			if (done) break;

			size += value.byteLength;

			if (size > maxBytes) {
				await reader.cancel();

				return new Response(null, { status: 413 });
			}

			chunks.push(value);
		}
	}

	const body = Buffer.concat(chunks);
	const request = new Request(event.request.url, { method: "POST", headers: event.request.headers, body });

	return agentsApi.http({ ...event, request });
}
