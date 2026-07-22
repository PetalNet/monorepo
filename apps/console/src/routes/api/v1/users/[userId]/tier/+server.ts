import { consoleApi } from "$lib/server/api/instance";
import { Effect, Option, Schema } from "effect";
import { Handler } from "svelte-effect-runtime/server";

import type { RequestHandler } from "./$types";

const TierUpdate = Schema.Struct({ tier: Schema.Literals(["operator", "editor", "viewer"]) });

export const PUT = Handler<RequestHandler>(function* ({ locals, params, request }) {
	if (locals.tier !== "owner") return Response.json({ error: "forbidden" }, { status: 403 });
	const decoded = yield* Effect.tryPromise(() => request.text()).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TierUpdate))),
		Effect.option,
	);
	if (Option.isNone(decoded)) return Response.json({ error: "invalid tier" }, { status: 400 });
	const { tier } = decoded.value;
	const api = yield* Effect.tryPromise(() => consoleApi()).pipe(Effect.orDie);
	const response = yield* Effect.tryPromise(() =>
		api.fetch(
			new Request(new URL("/api/v1/op", request.url), {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify({
					schema_version: 1,
					id: crypto.randomUUID(),
					op: "governance.user_tier",
					args: { user_id: params.userId, tier },
				}),
			}),
		),
	).pipe(Effect.orDie);
	return response ?? Response.json({ error: "operation unavailable" }, { status: 503 });
});
