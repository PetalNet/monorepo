import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "interest-test-"));

process.env.TASKS_DB_PATH = path.join(tmp, "tasks.db");
process.env.TASKS_CONFIG = path.join(tmp, "config.json");

writeFileSync(
	process.env.TASKS_CONFIG,
	JSON.stringify({ people: { parker: { name: "Parker", kind: "human", github: "PetalCat" } } }),
);

const db = await import("#lib/server/db.js");
const { Viewer } = await import("#lib/server/gallery/feedback.ts");
const { GitHub } = await import("#lib/server/gallery/github.ts");
const { choose, opened, viewerInterest } = await import("#lib/server/gallery/interest.ts");
const { ongoing } = await import("#lib/server/gallery/ongoing.ts");

afterAll(() => {
	db.default.close();
	rmSync(tmp, { recursive: true, force: true });
});

const pull = (repo: string, number: number, author: string, reviewers: string[] = []) => ({
	label: `${repo}#${number}`,
	repo,
	number,
	title: `PR ${number}`,
	url: `https://github.com/${repo}/pull/${number}`,
	author,
	bot: false,
	updatedAt: "2026-11-19T10:00:00Z",
	ci: "passing" as const,
	review: "none" as const,
	reviewers,
});

const github = Layer.succeed(GitHub, {
	openPulls: Effect.succeed([
		pull("Acme/Atlas", 1, "petalcat"),
		pull("Acme/Harbor", 2, "someone", ["PetalCat"]),
		pull("Acme/Lumen", 3, "someone"),
		pull("Acme/Elsewhere", 4, "someone"),
	]),
});

const as = <A, E>(
	user: string,
	effect: Effect.Effect<A, E, typeof Viewer.Identifier | typeof GitHub.Identifier>,
) =>
	Effect.runPromise(effect.pipe(Effect.provide(github), Effect.provideService(Viewer, { user })));

const mine = async (user: string) => {
	const { interest } = await as(user, viewerInterest);

	return { projects: [...interest.mine].toSorted(), focused: interest.focused };
};

const publish = (slug: string, collection: string, extra: Record<string, unknown> = {}) =>
	db.upsertArtifact({ slug, title: slug, content: "x", owner: "janet", collection, ...extra });

beforeAll(() => {
	publish("atlas-demo", "atlas", { links: ["acme/atlas#1"] });
	publish("harbor-demo", "harbor", { links: ["acme/harbor#2"] });
	publish("lumen-demo", "lumen", { links: ["acme/lumen#3"] });
	publish("makkit-plan", "makkit", { caps: ["feedback"], audience: ["cooper"] });
	publish("quiet-note", "quiet");
	publish("eli-only", "secret", { owner: "eli", visibility: "private" });
});

describe("a viewer's projects", () => {
	it("is every project for someone nothing involves", async () => {
		expect(await mine("newcomer")).toEqual({
			projects: ["atlas", "harbor", "lumen", "makkit", "quiet"],
			focused: false,
		});
	});

	it("includes the projects whose pages link pull requests they wrote or review", async () => {
		expect(await mine("parker")).toEqual({ projects: ["atlas", "harbor"], focused: true });
	});

	it("includes a project that asks them something, and one where they answered", async () => {
		expect(await mine("cooper")).toEqual({ projects: ["makkit"], focused: true });

		db.insertFeedback({
			slug: "quiet-note",
			author: "cooper",
			anchor: {},
			payload: 1,
			ink: undefined,
			crop: undefined,
		});

		expect((await mine("cooper")).projects).toEqual(["makkit", "quiet"]);
	});

	it("includes a project they opened, until a month has passed", async () => {
		await as("parker", opened("lumen"));

		expect((await mine("parker")).projects).toEqual(["atlas", "harbor", "lumen"]);

		db.default
			.prepare(
				"UPDATE viewer_projects SET opened_at=datetime('now','-31 days') WHERE viewer='parker'",
			)
			.run();

		expect((await mine("parker")).projects).toEqual(["atlas", "harbor"]);
	});

	it("follows and hides by choice, and a cleared choice goes back to involvement", async () => {
		await as("parker", choose("quiet", "follow"));
		await as("parker", choose("harbor", "hide"));

		expect((await mine("parker")).projects).toEqual(["atlas", "quiet"]);

		await as("parker", choose("quiet", null));
		await as("parker", choose("harbor", null));

		expect((await mine("parker")).projects).toEqual(["atlas", "harbor"]);
	});

	it("keeps hidden projects out even when nothing else involves the viewer", async () => {
		await as("newcomer", choose("makkit", "hide"));

		expect(await mine("newcomer")).toEqual({
			projects: ["atlas", "harbor", "lumen", "quiet"],
			focused: false,
		});
	});

	it("refuses a project the viewer cannot see", async () => {
		expect(await as("parker", Effect.flip(choose("secret", "follow")))).toMatchObject({
			_tag: "ProjectNotFound",
		});

		expect(await as("parker", Effect.flip(opened("nowhere")))).toMatchObject({
			_tag: "ProjectNotFound",
		});
	});
});

describe("the viewer's own ongoing list", () => {
	const numbers = async (user: string, scope: { project?: string; show?: "all" } = {}) =>
		(await as(user, ongoing(scope))).pulls.map((p) => p.number).toSorted((x, y) => x - y);

	it("is their pull requests and the ones their projects' pages link", async () => {
		expect(await numbers("parker")).toEqual([1, 2]);
	});

	it("is everything when they ask for all", async () => {
		expect(await numbers("parker", { show: "all" })).toEqual([1, 2, 3, 4]);
	});

	it("says how many pull requests their own view leaves out", async () => {
		expect((await as("parker", ongoing({}))).more).toBe(2);
		expect((await as("parker", ongoing({ show: "all" }))).more).toBe(0);
	});

	it("leaves out a hidden project's pull requests for someone nothing involves", async () => {
		await as("fresh", choose("lumen", "hide"));

		expect(await numbers("fresh")).toEqual([1, 2, 4]);
		expect(await numbers("fresh", { show: "all" })).toEqual([1, 2, 3, 4]);
	});

	it("keeps unresolved answers on a page that asks them something, even in a hidden project", async () => {
		publish("ask-ada", "hushed", { caps: ["feedback"], audience: ["ada", "cooper"] });

		db.insertFeedback({
			slug: "ask-ada",
			author: "cooper",
			anchor: {},
			payload: 1,
			ink: undefined,
			crop: undefined,
		});

		await as("ada", choose("hushed", "hide"));

		expect((await as("ada", ongoing({}))).answers.map((a) => a.slug)).toContain("ask-ada");
	});

	it("is unchanged inside a project", async () => {
		expect(await numbers("parker", { project: "lumen" })).toEqual([3]);
	});
});
