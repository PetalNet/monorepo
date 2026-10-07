import { error } from "@sveltejs/kit";
import { z } from "zod";

import { jsonBody, requireAdmin } from "#lib/server/security.ts";
import { review } from "#lib/server/store.ts";

import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async (event) => {
	await requireAdmin(event);
	const parsed = z
		.object({
			ids: z.array(z.uuid()).min(1).max(500),
			decision: z.enum(["keep", "drop", "undecided"]),
		})
		.safeParse(await jsonBody(event, 25000));
	if (!parsed.success) error(400, "Choose up to 500 clips and a review decision.");
	await review(parsed.data.ids, parsed.data.decision);
	return Response.json({ ok: true });
};
