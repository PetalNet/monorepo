import { auth } from "$lib/server/auth";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

const tiers = new Set(["operator", "editor", "viewer"]);

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (locals.tier !== "owner") return json({ error: "forbidden" }, { status: 403 });
	const tier = String((await request.json() as { tier?: unknown }).tier ?? "");
	if (!tiers.has(tier)) return json({ error: "invalid tier" }, { status: 400 });
	const context = await auth.$context;
	const user = await context.adapter.update({ model: "user", where: [{ field: "id", value: params.userId }], update: { tier, updatedAt: new Date() } });
	return user ? json({ userId: params.userId, tier }) : json({ error: "not found" }, { status: 404 });
};
