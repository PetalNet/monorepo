import db, {
	listProjects,
	getProject,
	renameProject,
	setProjectVisibility,
	deleteProject,
	moveProject,
	archiveProject,
	unarchiveProject,
	listArchivedProjects,
} from "../../lib/server/db.js";

export function load({ locals }) {
	const me = locals.user;
	const projects = listProjects(me).map((p) => ({
		...p,
		count: db
			.prepare(
				"SELECT count(*) c FROM tasks WHERE project_id=? AND status NOT IN ('done','dropped')",
			)
			.get(p.id).c,
	}));

	return { projects, archived: listArchivedProjects(me), me };
}

// only act on a project the user can actually see (shared or owned)
const allowed = (id, me) => {
	const p = getProject(id);

	return p && (p.visibility === "shared" || p.owner === me) ? p : null;
};

export const actions = {
	rename: async ({ request, locals }) => {
		const f = await request.formData();
		const id = Number(f.get("id"));
		const name = String(f.get("name") || "").trim();

		if (name && allowed(id, locals.user)) {
			renameProject(id, name);
		}

		return { ok: true };
	},
	visibility: async ({ request, locals }) => {
		const f = await request.formData();
		const id = Number(f.get("id"));

		if (!allowed(id, locals.user)) {
			return { ok: false };
		}

		const priv = Boolean(f.get("private"));

		setProjectVisibility(id, priv ? "private" : "shared", priv ? locals.user : "");

		return { ok: true };
	},
	delete: async ({ request, locals }) => {
		const f = await request.formData();
		const id = Number(f.get("id"));

		if (allowed(id, locals.user)) {
			deleteProject(id);
		}

		return { ok: true };
	},
	move: async ({ request, locals }) => {
		const f = await request.formData();
		const id = Number(f.get("id"));
		const dest = Number(f.get("dest"));

		// move id's tasks into dest, then retire id; only projects the user can act on
		if (id && dest && id !== dest && allowed(id, locals.user) && allowed(dest, locals.user)) {
			moveProject(id, dest);
		}

		return { ok: true };
	},
	// archive a whole project (its tasks vanish from active views, not deleted) / restore it
	archive: async ({ request, locals }) => {
		const f = await request.formData();
		const p = allowed(Number(f.get("id")), locals.user);

		if (p) {
			archiveProject(p.name);
		}

		return { ok: true };
	},
	unarchive: async ({ request, locals }) => {
		const f = await request.formData();
		const name = String(f.get("name") || "");

		if (name) {
			unarchiveProject(name, locals.user);
		}

		return { ok: true };
	},
};
