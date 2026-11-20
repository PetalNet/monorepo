// oxlint-disable effecttsgo/unstable-api-usage -- Effect 4 exposes process services through unstable APIs.
import { createHash } from "node:crypto";

import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Vault } from "./engine.ts";
import type { Tx } from "./engine.ts";
import { CaptureFailed, WriteRejected } from "./errors.ts";
import { recallClaims, recallPassages } from "./recall.ts";
import type { ClaimCard, PassageHit } from "./recall.ts";
import {
	Gap,
	Relation,
	SourceType,
	Text,
	Verdict,
	freshness,
	oneLine,
	slug,
	tiers,
} from "./schema.ts";
import type { Claim, Link, Source, Tier } from "./schema.ts";

const CiteOutput = Schema.fromJsonString(
	Schema.Struct({
		source: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({
					id: Schema.String,
					title: Schema.String,
					url: Schema.String,
					fetched_at: Schema.String,
				}),
			),
		),
		citation: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({
					status: Schema.String,
					reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
				}),
			),
		),
		reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
	}),
);

export interface CitedSource {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly fetchedAt: string;
}

/** Vault-cite, which fetches and saves the artifacts claims cite. */
export class Cite extends Context.Service<
	Cite,
	{ readonly capture: (ref: string) => Effect.Effect<CitedSource, CaptureFailed> }
>()("vault-engine/Cite") {
	/**
	 * `command` is the vault-cite CLI as an argv prefix, for example `node
	 * packages/vault-cite/src/cli.ts`, or the same behind `ssh` when the source store lives on
	 * another host. With no command, every capture fails.
	 */
	static readonly layer = (command: readonly string[]) =>
		Layer.effect(
			Cite,
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const [program, ...prefix] = command;

				return {
					capture: (ref) =>
						Effect.gen(function* () {
							if (program === undefined) {
								return yield* new CaptureFailed({
									ref,
									reason: "No vault-cite command is configured (set VAULT_CITE)",
								});
							}

							const handle = yield* spawner.spawn(
								ChildProcess.make(
									program,
									[...prefix, ref.startsWith("src-") ? "get" : "add", ref],
									{
										stderr: "inherit",
									},
								),
							);
							const output = yield* Stream.mkString(Stream.decodeText(handle.stdout));
							const result = yield* Schema.decodeEffect(CiteOutput)(
								output.trim().split("\n").at(-1) ?? "",
							).pipe(Effect.orElseSucceed((): typeof CiteOutput.Type => ({})));

							if (!result.source) {
								return yield* new CaptureFailed({
									ref,
									reason:
										result.citation?.reason ??
										result.citation?.status ??
										result.reason ??
										"capture failed",
								});
							}

							return {
								id: result.source.id,
								title: result.source.title,
								url: result.source.url,
								fetchedAt: result.source.fetched_at,
							};
						}).pipe(
							Effect.scoped,
							Effect.catchTag("PlatformError", (error) =>
								Effect.fail(new CaptureFailed({ ref, reason: error.message })),
							),
						),
				};
			}),
		);
}

/**
 * Records a URL, DOI or arXiv ID as a source. A source the vault already holds is reused without a
 * fetch; anything else is captured through vault-cite first.
 */
export const captureSource = Effect.fnUntraced(function* (tier: Tier, ref: string) {
	const vault = yield* Vault;
	const view = yield* vault.view;
	const existing =
		view.source(ref) ??
		tiers
			.flatMap((each) => Object.values(view.tiers[each].sources))
			.find((source) => source.url === ref && source.status === "active");

	if (existing) {
		return existing;
	}

	const saved = yield* (yield* Cite).capture(ref);

	return yield* vault.transact(tier, `capture source ${saved.id}`, (tx) =>
		tx.putSource({
			id: saved.id,
			kind: "capture",
			title: oneLine(saved.title) || saved.url,
			url: saved.url,
			sourceType: "PRIMARY",
			captured: new Date(saved.fetchedAt).toISOString(),
			passages: {},
		}),
	);
});

export const Recheck = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	freshness: Schema.String,
	url: Schema.optionalKey(Schema.String),
});

export interface VaultCheck {
	readonly claims: readonly ClaimCard[];
	readonly passages: readonly PassageHit[];
	/**
	 * Sources behind those hits that are past shelf life, replaced or retracted: check these for
	 * something newer.
	 */
	readonly recheck: readonly (typeof Recheck.Type)[];
}

/**
 * Step one of every research run: what the vault already holds on the question, and how fresh it
 * is.
 */
export const researchCheck = Effect.fnUntraced(function* (question: string) {
	const k = 12;
	const claims = yield* recallClaims(question, { k });
	const passages = yield* recallPassages(question, { k });
	const recheck = new Map<string, typeof Recheck.Type>();

	for (const source of claims.flatMap((card) => card.sources)) {
		if (source.freshness !== "fresh") {
			recheck.set(source.id, {
				id: source.id,
				title: source.title,
				freshness: source.freshness,
				...(source.url === undefined ? {} : { url: source.url }),
			});
		}
	}

	for (const hit of passages) {
		if (hit.freshness !== "fresh" && !recheck.has(hit.source)) {
			recheck.set(hit.source, { id: hit.source, title: hit.title, freshness: hit.freshness });
		}
	}

	return { claims, passages, recheck: [...recheck.values()] } satisfies VaultCheck;
});

const TopicInput = Schema.Struct({
	title: Text,
	summary: Text,
	hub: Schema.optionalKey(Text),
	shelfLifeDays: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export const ResearchRunInput = Schema.Struct({
	question: Text,
	summary: Text,
	topics: Schema.Array(TopicInput).check(Schema.isMinLength(1)),
	/** Passages quoted from sources already in the vault. `key` names the passage within this input. */
	passages: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ key: Text, source: Text, text: Text, heading: Schema.optionalKey(Text) }),
		),
	),
	claims: Schema.Array(
		Schema.Struct({
			key: Text,
			topic: Text,
			heading: Text,
			text: Text,
			verdict: Verdict,
			sourceType: SourceType,
			links: Schema.Array(
				Schema.Struct({
					rel: Relation,
					to: Text.annotate({
						description:
							"A passage key from this input, a source ID, a claim key from this input or a claim ID.",
					}),
				}),
			),
			replaces: Schema.optionalKey(Text),
		}),
	),
	/** Existing claims and sources the answer relies on without changing them. */
	reused: Schema.optionalKey(Schema.Array(Text)),
	/** Claim keys or IDs that answer the question. */
	answer: Schema.Array(Text).check(Schema.isMinLength(1)),
	gaps: Schema.optionalKey(Schema.Array(Gap)),
});
export type ResearchRunInput = typeof ResearchRunInput.Type;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A topic's ID is the slug of its title. A different title that slugs the same ("C++" and "C#")
 * gets a hash suffix, so neither topic absorbs the other's claims.
 */
function topicId(tx: Tx, title: string, pending: Map<string, string>): string {
	const base = `t-${slug(title)}`;
	const holder = tx.state.topics[base]?.title ?? [...pending].find(([, id]) => id === base)?.[0];
	const mine =
		holder === undefined
			? slug(title) !== "untitled"
			: holder.toLowerCase() === title.toLowerCase();

	return mine ? base : `${base}-${hash(title.toLowerCase()).slice(0, 6)}`;
}

interface TopicUpsert {
	readonly title: string;
	/** Kept from the existing topic when absent. */
	readonly summary?: string;
	readonly hub?: string;
	readonly shelfLifeDays?: number;
}

const upsertTopics = Effect.fnUntraced(function* (tx: Tx, topics: readonly TopicUpsert[]) {
	const ids = new Map<string, string>();

	for (const topic of topics) {
		ids.set(oneLine(topic.title), topicId(tx, oneLine(topic.title), ids));
	}

	for (const topic of topics) {
		const title = oneLine(topic.title);
		const id = ids.get(title) ?? "";
		const existing = tx.state.topics[id];
		const hubTitle = topic.hub === undefined ? undefined : oneLine(topic.hub);
		const hub =
			hubTitle === undefined ? existing?.hub : (ids.get(hubTitle) ?? topicId(tx, hubTitle, ids));
		const shelfLifeDays = topic.shelfLifeDays ?? existing?.shelfLifeDays;

		if (
			hubTitle !== undefined &&
			hub !== undefined &&
			!(hub in tx.state.topics) &&
			!ids.has(hubTitle)
		) {
			yield* tx.putTopic({
				id: hub,
				title: hubTitle,
				summary: `Hub for ${hubTitle}.`,
				headings: [],
			});
		}

		yield* tx.putTopic({
			id,
			title: existing?.title ?? title,
			summary: oneLine(topic.summary ?? existing?.summary ?? title),
			headings: existing?.headings ?? [],
			...(hub === undefined ? {} : { hub }),
			...(shelfLifeDays === undefined ? {} : { shelfLifeDays }),
		});
	}

	return ids;
});

/**
 * Writes one research run as a tree: topics, claims and passages, rooted at a run note that lists
 * what the run created, updated, reused and found stale. Sources must already be in the vault (see
 * `captureSource`); a claim cannot cite a URL the vault never saved.
 */
export const researchRun = Effect.fnUntraced(function* (tier: Tier, input: ResearchRunInput) {
	const vault = yield* Vault;
	const view = yield* vault.view;
	const before = new Set(tiers.flatMap((each) => Object.keys(view.tiers[each].sources)));
	const cited = new Set(
		tiers.flatMap((each) =>
			Object.values(view.tiers[each].claims).flatMap((claim) =>
				claim.links.map((link) => link.target),
			),
		),
	);
	const quoted = input.passages ?? [];

	for (const id of [...quoted.map((passage) => passage.source), ...(input.reused ?? [])]) {
		if (!view.locate(id)) {
			return yield* new WriteRejected({
				message: `${id} is not in the vault; capture the source before the run`,
			});
		}
	}

	return yield* vault.transact(tier, `research run: ${input.question.slice(0, 80)}`, (tx) =>
		Effect.gen(function* () {
			const topicIds = yield* upsertTopics(tx, input.topics);
			const passageIds = new Map<string, { source: string; passage: string }>();
			const touched = new Set<string>();

			for (const passage of quoted) {
				const home = tx.locate(passage.source)?.tier;

				if (home !== tier) {
					return yield* new WriteRejected({
						message: `Source ${passage.source} lives in the ${home ?? "?"} tier; quote passages from a source in the ${tier} tier`,
					});
				}

				const known = Object.keys(tx.state.sources[passage.source]?.passages ?? {}).length;
				const id = yield* tx.addPassage(passage.source, passage.text, passage.heading);

				if (Object.keys(tx.state.sources[passage.source]?.passages ?? {}).length > known) {
					touched.add(passage.source);
				}

				passageIds.set(passage.key, { source: passage.source, passage: id });
			}

			const claimIds = new Map<string, string>();
			const superseded: string[] = [];

			for (const claim of input.claims) {
				const topic = topicIds.get(oneLine(claim.topic));

				if (topic === undefined) {
					return yield* new WriteRejected({
						message: `Claim ${claim.key} names topic "${claim.topic}", which the run does not define`,
					});
				}

				const links = claim.links.map((link): Link => {
					const passage = passageIds.get(link.to);

					return passage
						? { rel: link.rel, target: passage.source, passage: passage.passage }
						: { rel: link.rel, target: claimIds.get(link.to) ?? link.to };
				});
				const body = {
					text: claim.text,
					topic,
					heading: claim.heading,
					links,
					sourceType: claim.sourceType,
					verdict: claim.verdict,
				};
				const replaces =
					claim.replaces === undefined
						? undefined
						: (claimIds.get(claim.replaces) ?? claim.replaces);
				const added =
					replaces === undefined
						? yield* tx.addClaim(body)
						: yield* tx.replaceClaim(replaces, body);

				if (replaces !== undefined) {
					superseded.push(replaces);
				}

				claimIds.set(claim.key, added.id);
			}

			const created: string[] = [...claimIds.values()];
			const sourcesUsed = new Set(
				created
					.flatMap((id) => (tx.state.claims[id]?.links ?? []).map((link) => link.target))
					.filter((id) => !id.startsWith("c-")),
			);
			const reused = new Set(input.reused);
			const now = new Date(tx.now);

			for (const id of sourcesUsed) {
				const kind = tx.source(id)?.kind;
				// A migrated lab document is prior work by definition; a capture nothing cited before is new here.
				const prior = kind !== "capture" && kind !== "direct";

				if (prior || (before.has(id) && cited.has(id) && !touched.has(id))) {
					reused.add(id);
				} else if (!cited.has(id)) {
					created.push(id);
				}
			}

			const stale = [...reused].filter((id) => {
				const found = tx.locate(id);
				const claim: Claim | undefined =
					found?.kind === "claims" ? tx.tiers[found.tier].claims[id] : undefined;
				const source = tx.source(id);

				return (
					claim?.stale !== undefined ||
					(source !== undefined && freshness(source, undefined, now) !== "fresh")
				);
			});

			let id = `run-${tx.now.slice(0, 10)}-${slug(input.question).slice(0, 40).replace(/-+$/, "")}`;

			for (let n = 2; id in tx.state.runs; n++) {
				id = `${id.replace(/-\d+$/, "")}-${String(n)}`;
			}

			return yield* tx.putRun({
				id,
				question: oneLine(input.question),
				summary: input.summary,
				topics: [...new Set(topicIds.values())],
				answer: input.answer.map((key) => claimIds.get(key) ?? key),
				created,
				updated: [
					...new Set([...superseded, ...[...touched].filter((source) => cited.has(source))]),
				],
				reused: [...reused],
				stale,
				gaps: input.gaps ?? [],
			});
		}),
	);
});

export const RememberInput = Schema.Struct({
	text: Text,
	topic: Text,
	heading: Schema.optionalKey(
		Text.annotate({ description: "Heading in the topic note. Default: Notes." }),
	),
	source: Schema.optionalKey(
		Text.annotate({
			description:
				"A vault source ID, URL, DOI or arXiv ID. An unsaved reference is captured first.",
		}),
	),
	direct: Schema.optionalKey(
		Schema.Struct({ title: Text, quote: Text }).annotate({
			description: "Who said or observed it, with the quote. Recorded as a DIRECT source.",
		}),
	),
	quote: Schema.optionalKey(
		Text.annotate({ description: "The passage of `source` the claim rests on." }),
	),
	sourceType: Schema.optionalKey(SourceType),
	replaces: Schema.optionalKey(
		Text.annotate({
			description: "The claim this one corrects. The old claim stays, marked superseded.",
		}),
	),
});
export type RememberInput = typeof RememberInput.Type;

/**
 * Stores one sourced claim. Everything requires a source: a captured artifact, a DIRECT record of
 * who said or observed it, or an explicit GUESS.
 */
export const remember = Effect.fnUntraced(function* (tier: Tier, input: RememberInput) {
	const vault = yield* Vault;

	if (input.quote !== undefined && input.source === undefined && input.direct === undefined) {
		return yield* new WriteRejected({
			message: "A quote needs the source it was taken from (--source or --direct)",
		});
	}

	const captured: Source | undefined =
		input.source === undefined ? undefined : yield* captureSource(tier, input.source);

	if (
		captured &&
		input.quote !== undefined &&
		(yield* vault.view).locate(captured.id)?.tier !== tier
	) {
		return yield* new WriteRejected({
			message: `Source ${captured.id} lives in another tier; quote it from there`,
		});
	}

	return yield* vault.transact(tier, `remember in ${input.topic}`, (tx) =>
		Effect.gen(function* () {
			const [topic = ""] = (yield* upsertTopics(tx, [{ title: input.topic }])).values();
			const links: Link[] =
				input.replaces === undefined ? [] : [{ rel: "replaces", target: input.replaces }];
			let sourceType = input.sourceType ?? "GUESS";

			if (captured) {
				const passage =
					input.quote === undefined ? undefined : yield* tx.addPassage(captured.id, input.quote);

				links.push({
					rel: "source",
					target: captured.id,
					...(passage === undefined ? {} : { passage }),
				});

				sourceType = input.sourceType ?? captured.sourceType;
			}

			if (input.direct) {
				const title = oneLine(input.direct.title);
				// The tier is part of the ID: the same speaker recorded in two tiers is two sources.
				const id = `doc-${hash(`${tier}\n${title.toLowerCase()}`).slice(0, 16)}`;

				yield* tx.putSource({
					id,
					kind: "direct",
					title,
					sourceType: "DIRECT",
					captured: tx.state.sources[id]?.captured ?? tx.now,
					passages: {},
				});

				links.push({
					rel: "source",
					target: id,
					passage: yield* tx.addPassage(id, input.direct.quote),
				});

				sourceType = input.sourceType ?? "DIRECT";
			}

			return yield* tx.addClaim({
				text: oneLine(input.text),
				topic,
				heading: input.heading ?? "Notes",
				links,
				sourceType,
			});
		}),
	);
});
