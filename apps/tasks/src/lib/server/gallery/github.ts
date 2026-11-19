import { readFileSync } from "node:fs";

import { Config, Context, Data, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class GitHubUnavailable extends Data.TaggedError("GitHubUnavailable")<{
	readonly cause: unknown;
}> {}

/** One open pull request, reduced to what the gallery shows. */
export const Pull = Schema.Struct({
	/** "owner/repo#12", the form the gallery's link search takes. */
	label: Schema.String,
	repo: Schema.String,
	number: Schema.Int,
	title: Schema.String,
	url: Schema.String,
	author: Schema.String,
	bot: Schema.Boolean,
	updatedAt: Schema.String,
	ci: Schema.Literals(["failing", "running", "passing", "none"]),
	review: Schema.Literals(["draft", "changes", "approved", "requested", "none"]),
	/** Everyone asked to review, or who has reviewed. */
	reviewers: Schema.Array(Schema.String),
});

export type Pull = typeof Pull.Type;

/**
 * The open pull requests the configured search finds. `undefined` when no search is configured, so
 * a gallery without GitHub shows nothing rather than an error.
 */
export class GitHub extends Context.Service<
	GitHub,
	{ readonly openPulls: Effect.Effect<readonly Pull[] | undefined, GitHubUnavailable> }
>()("tasks/GitHub") {}

const Actor = Schema.NullOr(Schema.Struct({ type: Schema.String, login: Schema.String }));

const Node = Schema.Struct({
	number: Schema.Int,
	title: Schema.String,
	url: Schema.String,
	isDraft: Schema.Boolean,
	updatedAt: Schema.String,
	repository: Schema.Struct({ nameWithOwner: Schema.String }),
	author: Actor,
	statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
	reviewRequests: Schema.Struct({
		nodes: Schema.Array(
			Schema.Struct({
				requestedReviewer: Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
			}),
		),
	}),
	latestReviews: Schema.Struct({
		nodes: Schema.Array(Schema.Struct({ author: Actor, state: Schema.String })),
	}),
});

const Page = Schema.Struct({
	data: Schema.Struct({
		search: Schema.Struct({
			pageInfo: Schema.Struct({
				hasNextPage: Schema.Boolean,
				endCursor: Schema.NullOr(Schema.String),
			}),
			nodes: Schema.Array(Node),
		}),
	}),
});

// PullRequest.statusCheckRollup is the head commit's rollup without reading commits, so the token
// needs no access to repository contents.
const QUERY = `query ($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt
        repository { nameWithOwner }
        author { type: __typename login }
        statusCheckRollup { state }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        latestReviews(first: 20) { nodes { author { type: __typename login } state } }
      }
    }
  }
}`;

const CI: Record<string, Pull["ci"]> = {
	FAILURE: "failing",
	ERROR: "failing",
	PENDING: "running",
	EXPECTED: "running",
	SUCCESS: "passing",
};

const toPull = (node: typeof Node.Type): Pull => {
	const repo = node.repository.nameWithOwner;
	const reviews = node.latestReviews.nodes;
	const requested = node.reviewRequests.nodes.flatMap((r) => r.requestedReviewer?.login ?? []);
	const state = node.statusCheckRollup?.state;

	return {
		label: `${repo}#${node.number}`,
		repo,
		number: node.number,
		title: node.title,
		url: node.url,
		author: node.author?.login ?? "ghost",
		bot: node.author?.type === "Bot",
		updatedAt: node.updatedAt,
		ci: CI[state ?? ""] ?? "none",
		// Branch protection is not required for any of this, unlike GitHub's own reviewDecision.
		review: node.isDraft
			? "draft"
			: reviews.some((r) => r.state === "CHANGES_REQUESTED")
				? "changes"
				: reviews.some((r) => r.state === "APPROVED")
					? "approved"
					: requested.length > 0
						? "requested"
						: "none",
		reviewers: [...new Set([...requested, ...reviews.flatMap((r) => r.author?.login ?? [])])],
	};
};

/** Pages are 100 pull requests; ten is far past any real backlog and bounds a runaway search. */
const MAX_PAGES = 10;

/**
 * GITHUB_PULLS_SEARCH is a GitHub search ("org:acme is:pr is:open archived:false") and
 * GITHUB_TOKEN_FILE holds a read-only token (pull requests, commit statuses, actions), read on
 * every refresh so a rotated token needs no restart. One refresh a minute serves every viewer; a
 * failed refresh is retried after ten seconds.
 */
export const GitHubLive = Layer.effect(
	GitHub,
	Effect.gen(function* () {
		const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
		// compose passes an unset variable through as an empty string
		const search = Option.filter(
			yield* Config.option(Config.String("GITHUB_PULLS_SEARCH")),
			(q) => q.trim() !== "",
		);
		const tokenFile = yield* Config.option(Config.String("GITHUB_TOKEN_FILE"));

		if (Option.isNone(search) || Option.isNone(tokenFile)) {
			return GitHub.of({ openPulls: Effect.undefined });
		}

		const page = (token: string, after: string | null) =>
			HttpClientRequest.post("https://api.github.com/graphql").pipe(
				HttpClientRequest.bearerToken(token),
				HttpClientRequest.setHeader("user-agent", "petalnet-gallery"),
				HttpClientRequest.bodyJson({ query: QUERY, variables: { q: search.value, after } }),
				Effect.flatMap((request) => client.execute(request)),
				Effect.flatMap(HttpClientResponse.schemaBodyJson(Page)),
				Effect.map((body) => body.data.search),
			);

		const fetchAll = Effect.gen(function* () {
			const token = (yield* Effect.try({
				try: () => readFileSync(tokenFile.value, "utf8"),
				catch: (cause) => new GitHubUnavailable({ cause }),
			})).trim();

			// compose mounts /dev/null when no token file is set
			if (!token) {
				return yield* new GitHubUnavailable({ cause: "GITHUB_TOKEN_FILE is empty" });
			}

			const pulls: Pull[] = [];
			let after: string | null = null;

			for (let n = 0; n < MAX_PAGES; n++) {
				const result: (typeof Page.Type)["data"]["search"] = yield* page(token, after);

				pulls.push(...result.nodes.map(toPull));
				after = result.pageInfo.endCursor;

				if (!result.pageInfo.hasNextPage) {
					break;
				}
			}

			return pulls;
		}).pipe(
			Effect.timeout(Duration.seconds(10)),
			Effect.mapError((cause) => new GitHubUnavailable({ cause })),
		);

		const openPulls = yield* Effect.cachedWithTTL(fetchAll, (exit) =>
			Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.seconds(10),
		);

		return GitHub.of({ openPulls });
	}),
);
