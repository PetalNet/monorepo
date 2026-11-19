import { Effect } from "effect";

import { buildTree, projectKey } from "#lib/gallery-tree.js";
import { tasksConfig } from "#lib/server/config.js";
import { needsYou } from "#lib/server/db.js";
import { galleryApi } from "#lib/server/gallery/api.ts";
import { viewerInterest } from "#lib/server/gallery/interest.ts";

export async function load(event) {
	// The sidebar changes when someone answers a page, or follows or hides a project; those
	// invalidate this key.
	event.depends("gallery:tree");

	const { people } = tasksConfig;
	const user = event.locals.user;

	// The sidebar lists projects, so this load reads artifacts. The public share route has no
	// identity; it gets an empty tree.
	if (!user) {
		return { user, config: { people }, tree: [] };
	}

	const asked = Map.groupBy(needsYou(user), (a) => projectKey(a.collection));
	const tree = await galleryApi.run(
		Effect.map(viewerInterest, ({ artifacts, interest }) =>
			buildTree([...artifacts]).map((p) => ({
				...p,
				needs: asked.get(p.key)?.length ?? 0,
				// in the viewer's default view, and what they chose for it
				mine: interest.mine.has(p.key),
				choice: interest.choices.get(p.key),
			})),
		),
		event,
	);

	return { user, config: { people }, tree };
}
