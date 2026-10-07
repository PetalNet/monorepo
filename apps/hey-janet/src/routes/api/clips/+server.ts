import { error } from "@sveltejs/kit";

import { allPrompts, maxDuration } from "#lib/prompts.ts";
import { body, limit, session } from "#lib/server/security.ts";
import { saveClip } from "#lib/server/store.ts";

import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async (event) => {
	const p = await session(event);
	if (event.request.headers.get("x-participant-id") !== p.id)
		error(409, "This take belongs to another participant session. Reconnect the original session.");
	limit(`session:${p.id}`, 240);
	const index = Number(event.url.searchParams.get("prompt"));
	const prompt = allPrompts.find((_, i) => i === index);
	if (!prompt || !event.url.searchParams.has("prompt")) error(400, "Invalid prompt");
	const data = await body(event, 44 + maxDuration(prompt.kind) * 32000);
	try {
		return Response.json(
			await saveClip(
				p,
				event.url.searchParams.get("id") ?? "",
				event.url.searchParams.get("set") ?? "",
				index,
				data,
				event.request.headers.get("user-agent") ?? "",
			),
		);
	} catch (e) {
		error(422, e instanceof Error ? e.message : "Could not store take.");
	}
};
