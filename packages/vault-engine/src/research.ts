import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";

import { Vault } from "./engine.ts";
import type { Tx } from "./engine.ts";
import { WriteRejected } from "./errors.ts";
import { recallClaims, recallPassages } from "./recall.ts";
import type { ClaimCard, PassageHit } from "./recall.ts";
import { SourceType, Text, oneLine, slug } from "./schema.ts";
import type { Link, Source, Tier } from "./schema.ts";

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

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** A topic's ID is the slug of its title. */
const topicId = (title: string) => `t-${slug(title)}`;

interface TopicUpsert {
	readonly title: string;
}

const upsertTopics = Effect.fnUntraced(function* (tx: Tx, topics: readonly TopicUpsert[]) {
	const ids = new Map<string, string>();

	for (const topic of topics) {
		const title = oneLine(topic.title);
		const id = topicId(title);
		const existing = tx.state.topics[id];

		ids.set(title, id);

		yield* tx.putTopic({
			id,
			title: existing?.title ?? title,
			summary: oneLine(existing?.summary ?? title),
			headings: existing?.headings ?? [],
		});
	}

	return ids;
});

export const RememberInput = Schema.Struct({
	text: Text,
	topic: Text,
	heading: Schema.optionalKey(
		Text.annotate({ description: "Heading in the topic note. Default: Notes." }),
	),
	source: Schema.optionalKey(
		Text.annotate({
			description: "A vault source ID.",
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
		input.source === undefined ? undefined : (yield* vault.view).source(input.source);

	if (input.source !== undefined && captured === undefined) {
		return yield* new WriteRejected({ message: `Source ${input.source} is not in the vault` });
	}

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
