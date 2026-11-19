// The gallery's hierarchy, derived from the artifacts themselves: project (collection) > piece of
// work (the PR or issue an artifact links to) > artifact. Nothing here is stored; adding an
// artifact with a link is how a piece of work appears.

/** URL value for artifacts filed under no project. A real project can never be named this. */
export const UNFILED = "_";

/**
 * @typedef {{ url: string; kind: string; label: string }} Link
 *
 * @typedef {{ slug: string; collection: string; links: Link[] }} Filed
 */

/** The link that names the artifact's piece of work: its PR, else its issue. */
export const workOf = (/** @type {Link[]} */ links) =>
	links.find((l) => l.kind === "pr") ?? links.find((l) => l.kind === "issue");

export const projectKey = (/** @type {string} */ collection) => collection || UNFILED;

/**
 * Projects alphabetical, unfiled last; pieces of work newest first (the input is newest first).
 *
 * @param {Filed[]} artifacts
 */
export function buildTree(artifacts) {
	/**
	 * @type {Map<
	 * 	string,
	 * 	{
	 * 		key: string;
	 * 		name: string;
	 * 		count: number;
	 * 		works: Map<string, { key: string; label: string; url: string; count: number }>;
	 * 	}
	 * >}
	 */
	const projects = new Map();

	for (const a of artifacts) {
		const key = projectKey(a.collection);
		const project = projects.get(key) ?? {
			key,
			name: a.collection || "unfiled",
			count: 0,
			works: new Map(),
		};

		project.count += 1;
		const work = workOf(a.links);

		if (work) {
			const w = project.works.get(work.label) ?? {
				key: work.label,
				label: work.label,
				url: work.url,
				count: 0,
			};

			w.count += 1;
			project.works.set(w.key, w);
		}

		projects.set(key, project);
	}

	return [...projects.values()]
		.toSorted((x, y) => (x.key === UNFILED) - (y.key === UNFILED) || x.name.localeCompare(y.name))
		.map((p) => ({ ...p, works: [...p.works.values()] }));
}

/**
 * @template {Filed} T
 * @param {T[]} artifacts
 * @param {{ project?: string; work?: string }} scope
 */
export const inScope = (artifacts, { project, work }) =>
	artifacts.filter(
		(a) =>
			(!project || projectKey(a.collection) === project) &&
			(!work || workOf(a.links)?.label === work),
	);

/**
 * A gallery URL for one view state. Every filter lives in the query string so a link reproduces the
 * view.
 */
export function galleryHref({ project, work, link, view } = {}) {
	const q = new URLSearchParams();

	if (view) {
		q.set("view", view);
	}

	if (project) {
		q.set("project", project);
	}

	if (work) {
		q.set("work", work);
	}

	if (link) {
		q.set("link", link);
	}

	const s = q.toString();

	return s ? `/gallery?${s}` : "/gallery";
}
