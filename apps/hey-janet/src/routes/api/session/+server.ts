import { randomUUID } from "node:crypto";

import { error } from "@sveltejs/kit";
import { z } from "zod";

import { jsonBody, identity, limit, sign, verify } from "#lib/server/security.ts";
import { participant } from "#lib/server/store.ts";

import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async (event) => {
	limit(`start:${event.getClientAddress()}`, 30);
	const parsed = z
		.object({ name: z.string().trim().min(1).max(60), consent: z.literal(true) })
		.safeParse(await jsonBody(event, 1024));
	if (!parsed.success) error(400, "Enter a first name, up to 60 characters.");
	const auth = await identity(event);
	let id: string = randomUUID();
	try {
		const old = await verify(event.cookies.get("booth-participant") ?? "");
		if (
			typeof old.id === "string" &&
			old.name === parsed.data.name &&
			old.authSub === (auth?.sub ?? null)
		)
			id = old.id;
	} catch {
		/* A new participant gets a fresh ID. */
	}
	const p = participant(parsed.data.name, auth?.sub ?? null, id);
	event.cookies.set("booth-participant", await sign({ ...p }), {
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: event.url.protocol === "https:",
		maxAge: 30 * 86400,
	});
	return Response.json(p);
};
