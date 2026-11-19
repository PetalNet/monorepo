import { describe, expect, it } from "vitest";

import { buildTree, galleryHref, inScope, UNFILED } from "#lib/gallery-tree.js";

const pr = (label: string) => ({ url: `https://github.com/${label}`, kind: "pr", label });
const filed = (slug: string, collection: string, labels: string[] = []) => ({
	slug,
	collection,
	links: labels.map(pr),
});

const artifacts = [
	filed("a", "atlas", ["acme/atlas#41"]),
	filed("b", "atlas", ["acme/atlas#41"]),
	filed("c", "atlas"),
	filed("d", ""),
	filed("e", "harbor", ["acme/harbor#9"]),
];

describe("gallery hierarchy", () => {
	it("groups by project then by piece of work, unfiled last", () => {
		const tree = buildTree(artifacts);

		expect(tree.map((p) => [p.key, p.count])).toEqual([
			["atlas", 3],
			["harbor", 1],
			[UNFILED, 1],
		]);

		expect(tree[0]?.works).toEqual([
			{
				key: "acme/atlas#41",
				label: "acme/atlas#41",
				url: "https://github.com/acme/atlas#41",
				count: 2,
			},
		]);
	});

	it("narrows to a project and to one piece of work", () => {
		expect(inScope(artifacts, { project: "atlas" }).map((a) => a.slug)).toEqual(["a", "b", "c"]);

		expect(
			inScope(artifacts, { project: "atlas", work: "acme/atlas#41" }).map((a) => a.slug),
		).toEqual(["a", "b"]);

		expect(inScope(artifacts, { project: UNFILED }).map((a) => a.slug)).toEqual(["d"]);
	});

	it("writes every view state into the URL", () => {
		expect(galleryHref()).toBe("/gallery");

		expect(galleryHref({ project: "atlas", work: "acme/atlas#41" })).toBe(
			"/gallery?project=atlas&work=acme%2Fatlas%2341",
		);
	});
});
