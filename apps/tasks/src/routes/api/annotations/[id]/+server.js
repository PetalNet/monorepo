import { deleteAnnotation } from "$lib/server/db.js";
import { json, error } from "@sveltejs/kit";

// DELETE /api/annotations/<id>  — "ack & remove". Collaborative: any signed-in user
// (hooks.server.js already fail-closed gates to ALLOW) can clear a note.
export function DELETE({ params }) {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(400, "bad id");
	return json({ ok: deleteAnnotation(id) });
}
