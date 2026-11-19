import { readFileSync } from "node:fs";

import {
	Array,
	Clock,
	Config,
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Schema,
} from "effect";
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
	{
		readonly openPulls: Effect.Effect<readonly Pull[] | undefined, GitHubUnavailable>;
		/**
		 * Who took part in each pull request or issue, open or closed, keyed by the URL as given: a
		 * pull request's author and reviewers, an issue's author and commenters. A URL GitHub cannot
		 * answer for is absent, and nothing here fails: history only ever adds to what is yours.
		 */
		readonly participants: (
			urls: readonly string[],
		) => Effect.Effect<ReadonlyMap<string, readonly string[]>>;
	}
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

interface Ref {
	readonly url: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}

/** A pull request or issue URL as the gallery stores it, or undefined for any other link. */
const parseRef = (url: string): Ref | undefined => {
	const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)$/.exec(url);

	return m?.[1] && m[2] && m[3]
		? { url, owner: m[1], repo: m[2], number: Number(m[3]) }
		: undefined;
};

const People = Schema.Struct({
	nodes: Schema.Array(
		Schema.Struct({ author: Schema.NullOr(Schema.Struct({ login: Schema.String })) }),
	),
});

const Participants = Schema.Struct({
	data: Schema.Record(
		Schema.String,
		Schema.NullOr(
			Schema.Struct({
				issueOrPullRequest: Schema.NullOr(
					Schema.Struct({
						author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
						reviews: Schema.optional(People),
						comments: Schema.optional(People),
					}),
				),
			}),
		),
	),
});

// One aliased lookup per reference. Owner and repository names passed parseRef's pattern, so they
// are safe inside the query text.
const participantsQuery = (refs: readonly Ref[]) =>
	`query {${refs
		.map(
			(ref, i) => `
  r${i}: repository(owner: "${ref.owner}", name: "${ref.repo}") {
    issueOrPullRequest(number: ${ref.number}) {
      ... on PullRequest { author { login } reviews(first: 100) { nodes { author { login } } } }
      ... on Issue { author { login } comments(first: 100) { nodes { author { login } } } }
    }
  }`,
		)
		.join("")}
}`;

/** How long a pull request's or issue's participants stand before they are asked for again. */
const HISTORY_FRESH = 60 * 60_000;

/** Pages are 100 pull requests; ten is far past any real backlog and bounds a runaway search. */
const MAX_PAGES = 10;

/**
 * How long a result stands before a read starts a refresh: a minute, or ten seconds after a
 * failure.
 */
const FRESH = { ok: 60_000, failed: 10_000 };

/**
 * A read that finds a result older than this waits for the refresh, up to WAIT, before it answers.
 * With two viewers the last visit is often hours back, and checks and reviews have moved since.
 */
const TOO_OLD = 5 * 60_000;
const WAIT = Duration.seconds(3);

/**
 * GITHUB_PULLS_SEARCH is a GitHub search ("org:acme is:pr is:open archived:false") and
 * GITHUB_TOKEN_FILE holds a read-only token (pull requests, commit statuses, actions), read on
 * every refresh so a rotated token needs no restart.
 *
 * A read returns the last result and, when that has gone stale, starts one refresh in the
 * background. It waits for GitHub only when the last result is too old to show, and then briefly.
 * The first refresh starts with the layer.
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
			return GitHub.of({
				openPulls: Effect.undefined,
				participants: () => Effect.succeed(new Map()),
			});
		}

		const readToken = Effect.gen(function* () {
			const token = (yield* Effect.try({
				try: () => readFileSync(tokenFile.value, "utf8"),
				catch: (cause) => new GitHubUnavailable({ cause }),
			})).trim();

			// compose mounts /dev/null when no token file is set
			if (!token) {
				return yield* new GitHubUnavailable({ cause: "GITHUB_TOKEN_FILE is empty" });
			}

			return token;
		});
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
			const token = yield* readToken;
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
			// a defect too: a stored one would fail every page until the next refresh
			Effect.catchCause((cause) => Effect.fail(new GitHubUnavailable({ cause }))),
		);

		const scope = yield* Effect.scope;
		const last = yield* Ref.make<
			{ at: number; exit: Exit.Exit<readonly Pull[], GitHubUnavailable> } | undefined
		>(undefined);
		const running = yield* Ref.make<Deferred.Deferred<undefined> | undefined>(undefined);
		/** Starts a refresh unless one is running; either way, the signal that it has finished. */
		const refresh = Effect.gen(function* () {
			const mine = Deferred.makeUnsafe<undefined>();
			const done = yield* Ref.modify(running, (current) => [current ?? mine, current ?? mine]);

			if (done === mine) {
				yield* fetchAll.pipe(
					Effect.exit,
					Effect.flatMap((exit) =>
						Effect.flatMap(Clock.currentTimeMillis, (at) => Ref.set(last, { at, exit })),
					),
					Effect.ensuring(
						Effect.andThen(Ref.set(running, undefined), Deferred.succeed(done, undefined)),
					),
					Effect.forkIn(scope),
				);
			}

			return done;
		});
		const boot = yield* refresh;

		const openPulls = Effect.gen(function* () {
			yield* Deferred.await(boot);

			const result = yield* Ref.get(last);

			if (!result) {
				return yield* new GitHubUnavailable({ cause: "the first refresh was interrupted" });
			}

			const age = (yield* Clock.currentTimeMillis) - result.at;

			if (age <= (Exit.isSuccess(result.exit) ? FRESH.ok : FRESH.failed)) {
				return yield* result.exit;
			}

			const done = yield* refresh;

			if (age <= TOO_OLD) {
				return yield* result.exit;
			}

			yield* Deferred.await(done).pipe(Effect.timeoutOption(WAIT));

			return yield* ((yield* Ref.get(last)) ?? result).exit;
		});

		const known = new Map<string, { at: number; logins: readonly string[] }>();
		const ask = (refs: readonly Ref[]) =>
			Effect.gen(function* () {
				const token = yield* readToken;
				const body = yield* HttpClientRequest.post("https://api.github.com/graphql").pipe(
					HttpClientRequest.bearerToken(token),
					HttpClientRequest.setHeader("user-agent", "petalnet-gallery"),
					HttpClientRequest.bodyJson({ query: participantsQuery(refs) }),
					Effect.flatMap((request) => client.execute(request)),
					Effect.flatMap(HttpClientResponse.schemaBodyJson(Participants)),
				);
				const at = yield* Clock.currentTimeMillis;

				// a repository the token cannot read comes back null: remembered as nobody
				refs.forEach((ref, i) => {
					const item = body.data[`r${i}`]?.issueOrPullRequest;
					const actors = [
						item?.author,
						...((item?.reviews ?? item?.comments)?.nodes.map((n) => n.author) ?? []),
					];

					known.set(ref.url, { at, logins: [...new Set(actors.flatMap((a) => a?.login ?? []))] });
				});
			});
		const participants = (urls: readonly string[]) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const due = urls
					.filter((url) => now - (known.get(url)?.at ?? -Infinity) > HISTORY_FRESH)
					.flatMap((url) => parseRef(url) ?? []);

				// closed work rarely changes, so this is one request for new links and then none for an hour
				yield* Effect.forEach(Array.chunksOf(due, 40), ask, { discard: true, concurrency: 1 }).pipe(
					Effect.timeout(WAIT),
					Effect.catchCause((cause) =>
						Effect.logWarning("pull request history unavailable", cause),
					),
				);

				return new Map(
					urls.flatMap((url) => (known.has(url) ? [[url, known.get(url)!.logins]] : [])),
				);
			});

		return GitHub.of({ openPulls, participants });
	}),
);
