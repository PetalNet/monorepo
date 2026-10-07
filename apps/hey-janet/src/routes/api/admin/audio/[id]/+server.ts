import { error } from "@sveltejs/kit";

import { requireAdmin } from "#lib/server/security.ts";
import { allClips, audio } from "#lib/server/store.ts";

import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	await requireAdmin(event);
	const clip = (await allClips()).find((c) => c.clipId === event.params.id);
	if (!clip) error(404, "Clip not found");
	const bytes = await audio(clip);
	return new Response(bytes, {
		headers: {
			"Content-Type": "audio/wav",
			"Content-Length": String(bytes.length),
			"Content-Disposition": `inline; filename="${clip.file}"`,
		},
	});
};
