import { auth } from "$lib/server/auth";
import { Schema } from "effect";
import type { RequestHandler } from "./$types";

const TierUpdate = Schema.Struct({ tier: Schema.Literals(["operator", "editor", "viewer"]) });

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (locals.tier !== "owner") return Response.json({ error: "forbidden" }, { status: 403 });
	const decoded = await Schema.decodeUnknownPromise(Schema.fromJsonString(TierUpdate))(await request.text()).then(
		(value) => ({ valid: true as const, value }),
		() => ({ valid: false as const }),
	);
	if (!decoded.valid) return Response.json({ error: "invalid tier" }, { status: 400 });
	const { tier } = decoded.value;
	const context = await auth.$context;
	const user = await context.adapter.update({ model: "user", where: [{ field: "id", value: params.userId }], update: { tier, updatedAt: new Date() } });
	return user ? Response.json({ userId: params.userId, tier }) : Response.json({ error: "not found" }, { status: 404 });
};
