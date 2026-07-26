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
	// The substrate being unreachable (consoleApi build) or the op dispatch throwing are transient
	// availability faults, not defects: fold them into the same 503 the null result already returns
	// rather than orDie-ing them into an opaque 500.
	const response = yield* Effect.gen(function* () {
		const api = yield* Effect.promise(() => consoleApi());
		return yield* Effect.promise(() =>
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
		);
	}).pipe(Effect.catch(() => Effect.succeed(null)));
	return response ?? Response.json({ error: "operation unavailable" }, { status: 503 });
});
