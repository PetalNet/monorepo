import { getTermAudit } from "$lib/server/db.js";
import { error } from "@sveltejs/kit";

// Audit is ADMIN-ONLY — it exposes rw keystroke transcripts of a root-equivalent shell. Keep this
// gate in lockstep with TERM_ADMIN (server.js / docker-compose / fleet/+page.server.js).
const ADMIN = (process.env.TERM_ADMIN || "alice,bob")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

export function load({ locals, url }) {
	if (!ADMIN.includes(locals.user)) throw error(403, "Audit log is admin-only");
	const sessionId = url.searchParams.get("session");
	if (sessionId) {
		const { session, input } = getTermAudit({ sessionId: Number(sessionId) });
		if (!session) throw error(404, "No such session");
		return { me: locals.user, detail: { session, input } };
	}
	return { me: locals.user, sessions: getTermAudit().sessions };
}
