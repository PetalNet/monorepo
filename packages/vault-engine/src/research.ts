import { Effect, Schema } from "effect";

import { Vault } from "./engine.ts";
import type { Tx } from "./engine.ts";
import { Text, oneLine, slug } from "./schema.ts";
import type { Tier } from "./schema.ts";

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
});
export type RememberInput = typeof RememberInput.Type;

/** Stores one claim. With nothing to cite yet, every claim is a GUESS. */
export const remember = Effect.fnUntraced(function* (tier: Tier, input: RememberInput) {
	const vault = yield* Vault;

	return yield* vault.transact(tier, `remember in ${input.topic}`, (tx) =>
		Effect.gen(function* () {
			const [topic = ""] = (yield* upsertTopics(tx, [{ title: input.topic }])).values();

			return yield* tx.addClaim({
				text: oneLine(input.text),
				topic,
				heading: input.heading ?? "Notes",
				sourceType: "GUESS",
			});
		}),
	);
});
