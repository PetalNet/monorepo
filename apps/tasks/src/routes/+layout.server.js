import { buildTree, projectKey } from "#lib/gallery-tree.js";
import { tasksConfig } from "#lib/server/config.js";
import { listArtifacts, needsYou } from "#lib/server/db.js";

export function load({ locals, depends }) {
	// the sidebar counts change when someone answers a page; ArtifactView invalidates this key then
	depends("gallery:tree");

	const { people } = tasksConfig;
	const user = locals.user;

	// The sidebar lists projects, so this load reads artifacts. listArtifacts skips its visibility
	// gate for a falsy viewer (host scripts), so a request with no identity gets an empty tree.
	if (!user) {
		return { user, config: { people }, tree: [] };
	}

	const asked = Map.groupBy(needsYou(user), (a) => projectKey(a.collection));
	const tree = buildTree(
		listArtifacts(user).map((a) => ({ ...a, links: JSON.parse(a.links) })),
	).map((p) => ({ ...p, needs: asked.get(p.key)?.length ?? 0 }));

	return { user, config: { people }, tree };
}
