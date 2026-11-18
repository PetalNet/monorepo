import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";

import { Vault } from "./engine.ts";
import type { Tx } from "./engine.ts";
import { SourceType, Text, oneLine, slug } from "./schema.ts";
import type { Link, Tier } from "./schema.ts";

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
	direct: Schema.optionalKey(
		Schema.Struct({ title: Text, quote: Text }).annotate({
			description: "Who said or observed it, with the quote. Recorded as a DIRECT source.",
		}),
	),
	sourceType: Schema.optionalKey(SourceType),
});
export type RememberInput = typeof RememberInput.Type;

/**
 * Stores one sourced claim. Everything requires a source: a DIRECT record of who said or observed
 * it, or an explicit GUESS.
 */
export const remember = Effect.fnUntraced(function* (tier: Tier, input: RememberInput) {
	const vault = yield* Vault;

	return yield* vault.transact(tier, `remember in ${input.topic}`, (tx) =>
		Effect.gen(function* () {
			const [topic = ""] = (yield* upsertTopics(tx, [{ title: input.topic }])).values();
			const links: Link[] = [];
			let sourceType = input.sourceType ?? "GUESS";

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
