import { error } from "@sveltejs/kit";
import { z } from "zod";

import { requireAdmin } from "#lib/server/security.ts";
import { deleteParticipant } from "#lib/server/store.ts";

import type { RequestHandler } from "./$types";
export const DELETE: RequestHandler = async (event) => {
	await requireAdmin(event);
	const id = z.union([z.uuid(), z.string().regex(/^[a-f0-9]{32}$/)]).safeParse(event.params.id);
	if (!id.success) error(400, "Invalid participant ID.");
	if (!(await deleteParticipant(id.data))) error(404, "Participant not found.");
	return new Response(null, { status: 204 });
};
