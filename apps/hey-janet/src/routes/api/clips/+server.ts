import { error } from "@sveltejs/kit";

import { body, limit, session } from "#lib/server/security.ts";
import { saveClip } from "#lib/server/store.ts";

import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async (event) => {
	const p = await session(event);
	if (event.request.headers.get("x-participant-id") !== p.id)
		error(409, "This take belongs to another participant session. Reconnect the original session.");
	limit(`session:${p.id}`, 240);
	const index = Number(event.url.searchParams.get("prompt"));
	if (!Number.isInteger(index)) error(400, "Invalid prompt");
	const data = await body(event, 256044);
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
