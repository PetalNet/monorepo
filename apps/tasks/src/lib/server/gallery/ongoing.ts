import { Effect, Option } from "effect";

import { inScope, projectKey, workOf, type Filed, type Link } from "../../gallery-tree.js";
import { needsYou, openFeedback } from "../db.js";
import { StoreError, Viewer } from "./feedback.ts";
import type { Pull } from "./github.ts";
import { isTheirs, viewerInterest } from "./interest.ts";
import type { Ongoing, OngoingRequest } from "./schema.ts";

type OngoingPull = Ongoing["pulls"][number];

type Scope = typeof OngoingRequest.Type;

const CI_RANK = { failing: 0, running: 1, passing: 2, none: 2 } as const;
const REVIEW_RANK = { changes: 0, requested: 1, approved: 2, none: 2, draft: 3 } as const;

/**
 * The pull requests for one view of the gallery, most urgent first: failing checks, then changes
 * requested, then waiting for review; dependency bots last; newest first within each.
 *
 * Without a project this is every pull request. A project sees the ones its pages link to, and a
 * piece of work sees itself.
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

/**
 * What is in motion in one view of the gallery, given what the viewer sees. Without a project the
 * view is the viewer's own unless they ask for everything: their projects' pages, the pull requests
 * they wrote or review, and the ones those pages link. A page that asks them something counts
 * wherever it is filed.
 */
export const ongoingOf = (
	{ artifacts, pulls, interest }: Effect.Success<typeof viewerInterest>,
	scope: Scope,
) =>
	Effect.gen(function* () {
		const { user } = yield* Viewer;
		const read = yield* Effect.try({
			try: () => ({
				answers: openFeedback(user),
				asked: new Set(needsYou(user).map((a) => a.slug)),
			}),
			catch: (cause) => new StoreError({ cause }),
		});
		const own = !scope.project && !scope.work && scope.show !== "all";
		const mine = artifacts.filter((a) => !own || interest.mine.has(projectKey(a.collection)));
		const slugs = new Set(inScope(mine, scope).map((a) => a.slug));
		const urls = (pages: readonly Filed[]) =>
			new Set(pages.flatMap((a) => a.links.map((l) => l.url)));
		const linkedByMine = urls(mine);
		const linkedAtAll = urls(artifacts);
		const found = Option.getOrUndefined(pulls);
		const inView = pullsInScope(found ?? [], artifacts, scope);
		// Someone nothing involves yet keeps the pull requests no page links, since none are theirs.
		const shown = inView.filter(
			(p) =>
				!own ||
				isTheirs(p, interest.login) ||
				linkedByMine.has(p.url.toLowerCase()) ||
				(!interest.focused && !linkedAtAll.has(p.url.toLowerCase())),
		);

		return {
			github: Option.isNone(pulls) ? "unavailable" : found ? "ok" : "off",
			pulls: shown,
			more: inView.length - shown.length,
			answers: read.answers.filter((a) => slugs.has(a.slug) || (own && read.asked.has(a.slug))),
		} satisfies Ongoing;
	});

/** What is in motion for the signed-in viewer, in one view of the gallery. */
export const ongoing = (scope: Scope) =>
	Effect.flatMap(viewerInterest, (seen) => ongoingOf(seen, scope));
