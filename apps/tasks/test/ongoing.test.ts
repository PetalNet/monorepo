import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "ongoing-test-"));

process.env.TASKS_DB_PATH = path.join(tmp, "tasks.db");

const db = await import("#lib/server/db.js");
const { Viewer } = await import("#lib/server/gallery/feedback.ts");
const { GitHub, GitHubLive } = await import("#lib/server/gallery/github.ts");
const { ongoing } = await import("#lib/server/gallery/ongoing.ts");

afterAll(() => {
	db.default.close();
	rmSync(tmp, { recursive: true, force: true });
});

type PullOf = typeof GitHub.Service.openPulls extends Effect.Effect<infer A, unknown> ? A : never;
type Pull = NonNullable<PullOf>[number];

const pull = (label: string, extra: Partial<Pull> = {}): Pull => {
	const [repo = "", number = ""] = label.split("#");

	return {
		label,
		repo,
		number: Number(number),
		title: label,
		url: `https://github.com/${repo}/pull/${number}`,
		author: "agent-1",
		bot: false,
		updatedAt: "2026-11-19T10:00:00Z",
		ci: "passing",
		review: "none",
		reviewers: [],
		...extra,
	};
};

const withGitHub = (
	layer: Layer.Layer<typeof GitHub.Identifier, unknown>,
	user = "parker",
	scope: { project?: string; work?: string } = {},
) =>
	Effect.runPromise(
		ongoing(scope).pipe(Effect.provide(layer), Effect.provideService(Viewer, { user })),
	);

describe("pull requests in a view", () => {
	const github = Layer.succeed(GitHub, {
		openPulls: Effect.succeed([
			pull("Acme/Atlas#1", { updatedAt: "2026-11-19T12:00:00Z" }),
			pull("Acme/Atlas#2", { review: "requested" }),
			pull("Acme/Atlas#3", { review: "changes" }),
			pull("Acme/Harbor#4", { ci: "failing" }),
			pull("Acme/Atlas#5", { ci: "failing", bot: true }),
			pull("Acme/Atlas#6", { review: "draft" }),
		]),
	});
	const numbers = async (scope: { project?: string; work?: string }) =>
		(await withGitHub(github, "parker", scope)).pulls.map((p) => p.number);

	beforeAll(() => {
		const publish = (slug: string, collection: string, links: string[]) =>
			db.upsertArtifact({ slug, title: slug, content: "x", owner: "parker", collection, links });

		// GitHub spells the repository "Acme/Atlas"; a page's link is stored lower-cased
		publish("a", "atlas", ["acme/atlas#1"]);
		publish("b", "atlas", ["acme/atlas#1", "acme/atlas#3"]);
		publish("c", "harbor", ["acme/harbor#4"]);
	});

	it("puts failing checks first, then review states, drafts and bots last", async () => {
		expect(await numbers({})).toEqual([4, 3, 2, 1, 6, 5]);
	});

	it("counts the pages that link to a pull request", async () => {
		const { pulls } = await withGitHub(github);

		expect(Object.fromEntries(pulls.map((p) => [p.number, p.pages]))).toMatchObject({
			1: 2,
			3: 1,
			4: 1,
			2: 0,
		});
	});

	it("shows a project the pull requests its pages link to", async () => {
		expect(await numbers({ project: "atlas" })).toEqual([3, 1]);
	});

	it("shows a piece of work only itself", async () => {
		expect(await numbers({ project: "atlas", work: "acme/atlas#1" })).toEqual([1]);
	});
});

describe("ongoing", () => {
	it("lists pages with unresolved answers the viewer can see", async () => {
		const publish = (slug: string, visibility: string) =>
			db.upsertArtifact({
				slug,
				title: slug,
				kind: "interactive",
				content: "<p>pick</p>",
				owner: "parker",
				visibility,
				collection: "demo",
				caps: ["feedback"],
				audience: ["parker", "eli"],
			});

		publish("open", "shared");
		publish("mine", "private");
		publish("closed", "shared");

		const answer = (slug: string, author: string) =>
			db.insertFeedback({ slug, author, anchor: {}, payload: 1, ink: undefined, crop: undefined });

		answer("open", "eli");
		answer("open", "parker");
		answer("mine", "parker");
		db.resolveFeedback({ id: answer("closed", "eli").id, resolution: "done" });

		const off = Layer.succeed(GitHub, { openPulls: Effect.undefined });
		const seen = async (user: string) =>
			(await withGitHub(off, user)).answers.map((a) => [a.slug, a.count]);

		expect(await seen("parker")).toEqual(
			expect.arrayContaining([
				["open", 2],
				["mine", 1],
			]),
		);

		expect(await seen("eli")).toEqual([["open", 2]]);
		expect((await withGitHub(off)).github).toBe("off");
	});
});

describe("GitHubLive", () => {
	const serve = async (respond: (body: { variables: { after: string | null } }) => unknown) => {
		const seen: { auth: string | undefined; q: string }[] = [];
		const server = createServer((req, res) => {
			let raw = "";

			req.on("data", (chunk: Buffer) => (raw += chunk.toString()));

			req.on("end", () => {
				const body = JSON.parse(raw) as { variables: { q: string; after: string | null } };

				seen.push({ auth: req.headers.authorization, q: body.variables.q });
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(respond(body)));
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});

		const tokenFile = path.join(tmp, "github-token");

		writeFileSync(tokenFile, "t0ken\n");

		const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
		const layer = GitHubLive.pipe(
			// GitHub's address is fixed, so the test sends its requests to the local server instead
			Layer.provide(
				Layer.effect(
					HttpClient.HttpClient,
					Effect.map(HttpClient.HttpClient, HttpClient.mapRequest(HttpClientRequest.setUrl(local))),
				).pipe(Layer.provide(FetchHttpClient.layer)),
			),
			Layer.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						GITHUB_PULLS_SEARCH: "org:acme is:pr is:open",
						GITHUB_TOKEN_FILE: tokenFile,
					}),
				),
			),
		);

		return { layer, seen, close: () => server.close() };
	};

	const node = (number: number, extra: Record<string, unknown> = {}) => ({
		number,
		title: `PR ${number}`,
		url: `https://github.com/Acme/Atlas/pull/${number}`,
		isDraft: false,
		updatedAt: "2026-11-19T10:00:00Z",
		repository: { nameWithOwner: "Acme/Atlas" },
		author: { type: "User", login: "agent-1" },
		statusCheckRollup: null,
		reviewRequests: { nodes: [] },
		latestReviews: { nodes: [] },
		...extra,
	});

	it("reads every page of the search, with the token, and maps checks and review state", async () => {
		const github = await serve(({ variables }) => ({
			data: {
				search:
					variables.after === null
						? {
								pageInfo: { hasNextPage: true, endCursor: "c1" },
								nodes: [
									node(1, {
										statusCheckRollup: { state: "FAILURE" },
										reviewRequests: {
											nodes: [{ requestedReviewer: { login: "eli" } }, { requestedReviewer: {} }],
										},
									}),
								],
							}
						: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [
									node(2, {
										statusCheckRollup: { state: "SUCCESS" },
										author: { type: "Bot", login: "renovate" },
										latestReviews: {
											nodes: [{ author: { type: "User", login: "parker" }, state: "APPROVED" }],
										},
									}),
									node(3, { isDraft: true, author: null }),
								],
							},
			},
		}));

		const result = await withGitHub(github.layer);

		github.close();

		expect(github.seen).toEqual([
			{ auth: "Bearer t0ken", q: "org:acme is:pr is:open" },
			{ auth: "Bearer t0ken", q: "org:acme is:pr is:open" },
		]);

		expect(result.github).toBe("ok");

		expect(
			result.pulls.map(({ label, ci, review, reviewers, bot, author }) => ({
				label,
				ci,
				review,
				reviewers,
				bot,
				author,
			})),
		).toEqual([
			{
				label: "Acme/Atlas#1",
				ci: "failing",
				review: "requested",
				reviewers: ["eli"],
				bot: false,
				author: "agent-1",
			},
			{
				label: "Acme/Atlas#3",
				ci: "none",
				review: "draft",
				reviewers: [],
				bot: false,
				author: "ghost",
			},
			{
				label: "Acme/Atlas#2",
				ci: "passing",
				review: "approved",
				reviewers: ["parker"],
				bot: true,
				author: "renovate",
			},
		]);
	});

	it("answers a second read from the last result", async () => {
		const github = await serve(() => ({
			data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1)] } },
		}));
		const twice = await Effect.runPromise(
			Effect.all([ongoing({}), ongoing({})], { concurrency: 1 }).pipe(
				Effect.provide(github.layer),
				Effect.provideService(Viewer, { user: "parker" }),
			),
		);

		github.close();

		expect(twice.map((result) => result.pulls.length)).toEqual([1, 1]);
		expect(github.seen).toHaveLength(1);
	});

	it("reports GitHub as unavailable instead of failing the view", async () => {
		const github = await serve(() => ({ message: "Bad credentials" }));
		const result = await withGitHub(github.layer);

		github.close();

		expect(result).toMatchObject({ github: "unavailable", pulls: [] });
	});

	it("does not call GitHub with an empty token file", async () => {
		const github = await serve(() => ({}));

		writeFileSync(path.join(tmp, "github-token"), "");

		const result = await withGitHub(github.layer);

		github.close();

		expect(result.github).toBe("unavailable");
		expect(github.seen).toEqual([]);
	});

	it("is off without a search", async () => {
		const layer = GitHubLive.pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
		);

		expect((await withGitHub(layer)).github).toBe("off");
	});
});
