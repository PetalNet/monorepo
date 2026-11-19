import { Effect, Option } from "effect";

import { inScope, workOf } from "../../gallery-tree.js";
import { listArtifacts, openFeedback } from "../db.js";
import { StoreError, Viewer } from "./feedback.ts";
import { GitHub, type Pull } from "./github.ts";

interface Link {
	readonly url: string;
	readonly kind: string;
	readonly label: string;
}

interface Filed {
	readonly slug: string;
	readonly collection: string;
	readonly links: Link[];
}

export interface OngoingPull extends Pull {
	/** How many pages the viewer can see that link to this pull request. */
	readonly pages: number;
}

/** A page with answers nobody has resolved yet. */
export interface OpenAnswers {
	readonly slug: string;
	readonly title: string;
	readonly collection: string;
	readonly count: number;
	readonly latest: string;
}

export interface Ongoing {
	/** "off": no search is configured. "unavailable": GitHub did not answer; `pulls` is empty. */
	readonly github: "ok" | "unavailable" | "off";
	readonly pulls: readonly OngoingPull[];
	readonly answers: readonly OpenAnswers[];
}

export interface Scope {
	readonly project?: string | undefined;
	readonly work?: string | undefined;
}

const CI_RANK = { failing: 0, running: 1, passing: 2, none: 2 } as const;
const REVIEW_RANK = { changes: 0, requested: 1, approved: 2, none: 2, draft: 3 } as const;

/**
 * The pull requests for one view of the gallery, most urgent first: failing checks, then changes
 * requested, then waiting for review; dependency bots last; newest first within each.
 *
 * Every project sees every pull request. A project sees the ones its pages link to, and a piece of
 * work sees itself.
 */
function pullsInScope(
	pulls: readonly Pull[],
	artifacts: readonly Filed[],
	scope: Scope,
): OngoingPull[] {
	const urls = (links: readonly Link[]) => links.filter((l) => l.kind === "pr").map((l) => l.url);
	const linked = Map.groupBy(
		artifacts.flatMap((a) => urls(a.links)),
		(url) => url,
	);
	const within = inScope([...artifacts], scope);
	// A page can link several pull requests, but it is filed under one piece of work.
	const scoped =
		scope.project || scope.work
			? new Set(
					within.flatMap((a) =>
						urls(scope.work ? [workOf(a.links)].filter((l) => l !== undefined) : a.links),
					),
				)
			: undefined;

	return pulls
		.filter((p) => !scoped || scoped.has(p.url.toLowerCase()))
		.map((p) => ({ ...p, pages: linked.get(p.url.toLowerCase())?.length ?? 0 }))
		.toSorted(
			(x, y) =>
				Number(x.bot) - Number(y.bot) ||
				CI_RANK[x.ci] - CI_RANK[y.ci] ||
				REVIEW_RANK[x.review] - REVIEW_RANK[y.review] ||
				y.updatedAt.localeCompare(x.updatedAt),
		);
}

/** What is in motion for the signed-in viewer, in one view of the gallery. */
export const ongoing = (scope: Scope) =>
	Effect.gen(function* () {
		const { user } = yield* Viewer;
		const github = yield* GitHub;
		const pulls = yield* github.openPulls.pipe(
			Effect.tapError((error) => Effect.logWarning("open pull requests unavailable", error)),
			Effect.option,
		);
		const read = yield* Effect.try({
			try: () => ({
				artifacts: (listArtifacts(user) as (Omit<Filed, "links"> & { links: string })[]).map(
					(a) => ({ ...a, links: JSON.parse(a.links) as Link[] }),
				),
				answers: openFeedback(user) as OpenAnswers[],
			}),
			catch: (cause) => new StoreError({ cause }),
		});
		const slugs = new Set(inScope(read.artifacts, scope).map((a) => a.slug));

		const found = Option.getOrUndefined(pulls);

		return {
			github: Option.isNone(pulls) ? "unavailable" : found ? "ok" : "off",
			pulls: pullsInScope(found ?? [], read.artifacts, scope),
			answers: read.answers.filter((a) => slugs.has(a.slug)),
		} satisfies Ongoing;
	});
