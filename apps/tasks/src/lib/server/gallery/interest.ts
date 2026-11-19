import { Data, Effect, Option } from "effect";

import { projectKey, type Filed } from "../../gallery-tree.js";
import { tasksConfig } from "../config.js";
import {
	listArtifacts,
	markProjectOpened,
	setProjectChoice,
	viewerInvolvement,
	viewerProjects,
} from "../db.js";
import { StoreError, Viewer } from "./feedback.ts";
import { GitHub, type Pull } from "./github.ts";

/** No project of that name holds a page the viewer can see. */
export class ProjectNotFound extends Data.TaggedError("ProjectNotFound") {}

type Choice = "follow" | "hide";

/** One viewer's relation to the projects they can see. */
interface Interest {
	/** The projects in the viewer's default view. */
	readonly mine: ReadonlySet<string>;
	readonly choices: ReadonlyMap<string, Choice>;
	/** False when nothing involves the viewer, so `mine` is simply every project they did not hide. */
	readonly focused: boolean;
	/** The viewer's GitHub login, lower-cased, when the config names one. */
	readonly login: string | undefined;
}

/** A project someone opened stays theirs this long after the last visit. */
const OPENED_DAYS = 30;

const store = <A>(run: () => A) =>
	Effect.try({ try: run, catch: (cause) => new StoreError({ cause }) });

export const isTheirs = (pull: Pull, login: string | undefined) =>
	login !== undefined &&
	[pull.author, ...pull.reviewers].some((who) => who.toLowerCase() === login);

/**
 * Which projects are the viewer's. A project is theirs when they follow it, or when they are
 * involved and have not hidden it: a page there asks them something, they answered one, or a page
 * there links a pull request they wrote or review. Once anything is theirs, a project they opened
 * lately is too. Until then they get every project, hidden ones aside.
 */
const interest = (pulls: readonly Pull[], artifacts: readonly Filed[]) =>
	Effect.gen(function* () {
		const { user } = yield* Viewer;
		const login = tasksConfig.people[user]?.github?.toLowerCase();
		const read = yield* store(() => ({
			involvement: viewerInvolvement(user),
			rows: viewerProjects(user),
		}));
		const theirs = new Set(pulls.filter((p) => isTheirs(p, login)).map((p) => p.url.toLowerCase()));
		const since = Date.now() - OPENED_DAYS * 86_400_000;
		const involved = new Set([
			...read.involvement.filter((i) => i.asked || i.answered).map((i) => projectKey(i.collection)),
			...artifacts
				.filter((a) => a.links.some((l) => theirs.has(l.url)))
				.map((a) => projectKey(a.collection)),
		]);
		const visited = new Set(
			read.rows
				.filter((r) => r.opened_at && Date.parse(`${r.opened_at.replace(" ", "T")}Z`) > since)
				.map((r) => r.project),
		);
		const choices = new Map(read.rows.flatMap((r) => (r.choice ? [[r.project, r.choice]] : [])));
		const all = [...new Set(artifacts.map((a) => projectKey(a.collection)))];
		const kept = (p: string) => choices.get(p) === "follow" || (involved.has(p) && !choices.has(p));
		// Looking around is not involvement: a visit adds a project to a view that is already
		// narrowed, and never narrows one.
		const focused = all.some(kept);
		const mine = focused
			? all.filter((p) => kept(p) || (visited.has(p) && !choices.has(p)))
			: all.filter((p) => choices.get(p) !== "hide");

		return {
			mine: new Set(mine),
			choices,
			focused,
			login,
		} satisfies Interest;
	});

/** The pages the viewer can see, the open pull requests, and which projects are theirs. */
export const viewerInterest = Effect.gen(function* () {
	const { user } = yield* Viewer;
	const github = yield* GitHub;
	const pulls = yield* github.openPulls.pipe(
		Effect.tapError((error) => Effect.logWarning("open pull requests unavailable", error)),
		Effect.option,
	);
	const artifacts = yield* store(() =>
		listArtifacts(user).map((a): Filed => ({ ...a, links: JSON.parse(a.links) })),
	);

	return {
		artifacts,
		pulls,
		interest: yield* interest(Option.getOrUndefined(pulls) ?? [], artifacts),
	};
});

const visibleProject = (project: string) =>
	Effect.gen(function* () {
		const { user } = yield* Viewer;
		const seen = yield* store(() =>
			listArtifacts(user).some((a) => projectKey(a.collection) === project),
		);

		if (!seen) {
			return yield* new ProjectNotFound();
		}

		return user;
	});

/** Follow or hide a project, or pass null to go back to following the viewer's involvement. */
export const choose = (project: string, choice: Choice | null) =>
	Effect.flatMap(visibleProject(project), (user) =>
		store(() => {
			setProjectChoice(user, project, choice);
		}),
	);

/** The viewer went to a project or to one of its pages. */
export const opened = (project: string) =>
	Effect.flatMap(visibleProject(project), (user) =>
		store(() => {
			markProjectOpened(user, project);
		}),
	);
