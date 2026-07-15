import { auth } from "$lib/server/auth";
import { Effect, Option, Schema } from "effect";
import { Handler } from "svelte-effect-runtime/server";

import type { RequestHandler } from "./$types";

const TierUpdate = Schema.Struct({ tier: Schema.Literals(["operator", "editor", "viewer"]) });

export const PUT = Handler<RequestHandler>(function* ({ locals, params, request }) {
	if (locals.tier !== "owner") return Response.json({ error: "forbidden" }, { status: 403 });
	const decoded = yield* Effect.promise(() => request.text()).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TierUpdate))),
		Effect.option,
	);
	if (Option.isNone(decoded)) return Response.json({ error: "invalid tier" }, { status: 400 });
	const { tier } = decoded.value;
	const context = yield* Effect.promise(() => auth.$context);
	const user = yield* Effect.promise(() =>
		context.adapter.update({
			model: "user",
			where: [{ field: "id", value: params.userId }],
			update: { tier, updatedAt: new Date() },
		}),
	);
	return user
		? Response.json({ userId: params.userId, tier })
		: Response.json({ error: "not found" }, { status: 404 });
});
