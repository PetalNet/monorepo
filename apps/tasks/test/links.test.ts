import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "links-test-"));

process.env.TASKS_DB_PATH = path.join(tmp, "tasks.db");

const db = await import("#lib/server/db.js");
const { canonicalLink, normalizeLinks } = await import("#lib/links.js");

afterAll(() => {
	db.default.close();
	rmSync(tmp, { recursive: true, force: true });
});

describe("canonicalLink", () => {
	it.each([
		["PetalNet/monorepo#818", "https://github.com/PetalNet/monorepo/pull/818"],
		[
			"https://github.com/PetalNet/monorepo/pull/818/",
			"https://github.com/PetalNet/monorepo/pull/818",
		],
		[
			"https://github.com/PetalNet/monorepo/pull/818#issuecomment-1",
			"https://github.com/PetalNet/monorepo/pull/818",
		],
		["PetalNet/monorepo@92c0a75", "https://github.com/PetalNet/monorepo/commit/92c0a75"],
		["PetalNet/monorepo", "https://github.com/PetalNet/monorepo"],
	])("%s", (input, url) => {
		expect(canonicalLink(input)).toBe(url);
	});

	it("rejects anything that is not GitHub", () => {
		expect(canonicalLink("https://example.com/PetalNet/monorepo")).toBeUndefined();
		expect(canonicalLink("data:text/html,x")).toBeUndefined();
	});
});

describe("normalizeLinks", () => {
	it("derives kind and label, dedupes, and keeps other https links", () => {
		expect(
			normalizeLinks([
				"PetalNet/monorepo#818",
				"https://github.com/PetalNet/monorepo/pull/818",
				{ url: "https://example.com/spec", label: "Spec" },
			]),
		).toEqual([
			{
				url: "https://github.com/PetalNet/monorepo/pull/818",
				kind: "pr",
				label: "PetalNet/monorepo#818",
			},
			{ url: "https://example.com/spec", kind: "link", label: "Spec" },
		]);
	});

	it("refuses a non-https URL", () => {
		expect(() => normalizeLinks(["http://example.com/x"])).toThrow(/https/);
		expect(() => normalizeLinks(["data:text/html,x"])).toThrow(/https/);
	});
});

describe("find an artifact from its PR", () => {
	it("finds by any form of the reference, keeps links across a republish, and respects visibility", () => {
		db.upsertArtifact({
			slug: "demo-pr",
			title: "Demo",
			content: "x",
			owner: "parker",
			links: ["PetalNet/monorepo#818"],
		});

		db.upsertArtifact({
			slug: "private-pr",
			title: "Private",
			content: "x",
			owner: "parker",
			visibility: "private",
			links: ["PetalNet/monorepo#818"],
		});

		db.upsertArtifact({
			slug: "other-pr",
			title: "Other",
			content: "x",
			owner: "parker",
			links: ["PetalNet/monorepo#819"],
		});

		db.upsertArtifact({ slug: "demo-pr", title: "Demo", content: "y", owner: "parker" });

		const slugs = (ref: string, me: string | null) =>
			db
				.findArtifactsByLink(ref, me)
				.map((a: { slug: string }) => a.slug)
				.toSorted();

		for (const ref of ["PetalNet/monorepo#818", "https://github.com/PetalNet/monorepo/pull/818"]) {
			expect(slugs(ref, "parker")).toEqual(["demo-pr", "private-pr"]);
		}

		expect(slugs("PetalNet/monorepo#818", "elisha")).toEqual(["demo-pr"]);
		expect(slugs("PetalNet/monorepo#818", null)).toEqual(["demo-pr", "private-pr"]);
		expect(slugs("PetalNet/monorepo#819", "elisha")).toEqual(["other-pr"]);
		expect(slugs("not a ref", "parker")).toEqual([]);
	});
});
