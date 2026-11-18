import path from "node:path";

import { Clock, Effect, FileSystem } from "effect";

import { Vault } from "./engine.ts";
import type { VaultView } from "./engine.ts";
import { freshness, tiers } from "./schema.ts";
import type { Claim, Link, Source, Tier, Topic } from "./schema.ts";
import { ifExists } from "./store.ts";

/** A claim promoted to its own note once claims in this many other topics link to it. */
const PROMOTE_AT = 3;

/** Everything the projection owns in the folder. The rest of the folder is left alone. */
const OWNED = ["Index.md", ...tiers];

interface PlacedClaim {
	readonly claim: Claim;
	readonly tier: Tier;
	/** Basename of the topic note holding the claim's block. */
	readonly note: string;
}

const day = (iso: string) => iso.slice(0, 10);
const yaml = (value: string) => JSON.stringify(value);
// `|`, `[` and `]` end a wikilink alias early; `%%`, `<` and a backtick would open a comment, tag or code span.
const alias = (text: string) =>
	text
		.replaceAll(/[|[\]<`]|%%/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim();

function fileName(title: string): string {
	return (
		title
			.replaceAll(/[\\/:*?"<>|#^[\]%`]/g, " ")
			.replaceAll(/\s+/g, " ")
			.trim()
			.slice(0, 120)
			// A leading dot makes a hidden file; trailing dots and spaces are illegal on some systems.
			.replace(/^[. ]+|[. ]+$/g, "") || "Untitled"
	);
}

/**
 * Text an agent supplied is data: backslashes, brackets, inline-field markers and comment openers
 * are escaped so none of it turns into Obsidian syntax.
 */
const literal = (text: string) =>
	text
		.replaceAll("\\", String.raw`\\`)
		.replaceAll(/[[\]<]/g, String.raw`\$&`)
		.replaceAll("::", String.raw`:\:`)
		.replaceAll("%%", String.raw`%\%`);

/** Renders every note from one view of the vault. Pure: the same view always yields the same files. */
function render(view: VaultView, now: Date): Map<string, string> {
	const files = new Map<string, string>();
	const claims = new Map<string, PlacedClaim>();
	const sources = new Map<string, Source>();
	const topicNote = new Map<string, string>();
	const dependents = new Map<string, { placed: PlacedClaim; link: Link }[]>();
	const inbound = new Map<string, PlacedClaim[]>();
	const taken = new Set<string>(["index"]);

	for (const tier of tiers) {
		const state = view.tiers[tier];

		// In ID order, so the same vault always yields the same file names.
		for (const topic of Object.values(state.topics).toSorted((a, b) => a.id.localeCompare(b.id))) {
			let note = fileName(topic.title);

			if (taken.has(note.toLowerCase())) {
				note = `${note} (${topic.id})`;
			}

			taken.add(note.toLowerCase());
			topicNote.set(`${tier}/${topic.id}`, note);
		}

		for (const source of Object.values(state.sources)) {
			sources.set(source.id, source);
		}

		for (const claim of Object.values(state.claims)) {
			const note = topicNote.get(`${tier}/${claim.topic}`);

			if (note !== undefined) {
				claims.set(claim.id, { claim, tier, note });
			}
		}
	}

	for (const placed of claims.values()) {
		for (const link of placed.claim.links) {
			if (link.target.startsWith("c-")) {
				inbound.set(link.target, [...(inbound.get(link.target) ?? []), placed]);
			} else {
				dependents.set(link.target, [...(dependents.get(link.target) ?? []), { placed, link }]);
			}
		}
	}

	const claimLink = (id: string, from?: string) => {
		const placed = claims.get(id);

		if (!placed) {
			return `\`${id}\``;
		}

		// A same-note link without an alias shows as a bare caret and ID in reading view.
		return placed.note === from ? `[[#^${id}|${id}]]` : `[[${placed.note}#^${id}]]`;
	};

	const target = (link: Link, from: string) => {
		if (link.target.startsWith("c-")) {
			return claimLink(link.target, from);
		}

		const found = sources.get(link.target);
		const anchor = link.passage === undefined ? "" : `#^${link.passage}`;

		return found ? `[[${link.target}${anchor}|${alias(found.title)}]]` : `\`${link.target}\``;
	};

	const claimLine = ({ claim, note }: PlacedClaim) => {
		const text = literal(claim.text);
		const fields = claim.links.map((link) => `[${link.rel}:: ${target(link, note)}]`);

		fields.push(`[basis:: ${claim.sourceType}]`);

		if (claim.stale && claim.status === "active") {
			fields.push(`[stale:: ${day(claim.stale.since)} ${claim.stale.sources.join(" ")}]`);
		}

		if (claim.supersededBy !== undefined) {
			fields.push(`[replaced-by:: ${claimLink(claim.supersededBy, note)}]`);
		}

		if (claim.status === "retracted" && claim.reason !== undefined) {
			fields.push(`[retracted:: ${alias(claim.reason)}]`);
		}

		return `- ${claim.status === "active" ? text : `~~${text}~~`} ${fields.join(" ")} ^${claim.id}`;
	};

	const topicFile = (tier: Tier, topic: Topic) => {
		const note = topicNote.get(`${tier}/${topic.id}`) ?? topic.id;
		const mine = [...claims.values()]
			.filter((placed) => placed.tier === tier && placed.claim.topic === topic.id)
			.toSorted(
				(a, b) =>
					a.claim.created.localeCompare(b.claim.created) || a.claim.id.localeCompare(b.claim.id),
			);
		const live = mine.filter((placed) => placed.claim.status === "active");
		const lines = [
			"---",
			"type: topic",
			`id: ${topic.id}`,
			`tier: ${tier}`,
			`summary: ${yaml(topic.summary)}`,
			"generated: vault-engine",
			"---",
			`# ${literal(topic.title)}`,
			"",
			literal(topic.summary),
		];

		for (const heading of new Set([
			...topic.headings,
			...live.map((placed) => placed.claim.heading),
		])) {
			const under = live.filter((placed) => placed.claim.heading === heading);

			if (under.length > 0) {
				lines.push("", `## ${literal(heading)}`, ...under.map(claimLine));
			}
		}

		for (const [status, title] of [
			["superseded", "Superseded"],
			["retracted", "Retracted"],
		] as const) {
			const past = mine.filter((placed) => placed.claim.status === status);

			if (past.length > 0) {
				lines.push("", `## ${title}`, ...past.map(claimLine));
			}
		}

		files.set(`${tier}/Topics/${note}.md`, `${lines.join("\n")}\n`);
	};

	const sourceFile = (tier: Tier, source: Source) => {
		const lines = [
			"---",
			"type: source",
			`kind: ${source.kind}`,
			`tier: ${tier}`,
			`aliases: ${JSON.stringify([alias(source.title)])}`,
			...(source.url === undefined ? [] : [`url: ${yaml(source.url)}`]),
			`source_type: ${source.sourceType}`,
			`captured: ${day(source.captured)}`,
			...(source.shelfLifeDays === undefined
				? []
				: [`shelf_life_days: ${String(source.shelfLifeDays)}`]),
			`status: ${freshness(source, now)}`,
			...(source.replacedBy === undefined
				? []
				: [`replaced_by: ${yaml(`[[${source.replacedBy}]]`)}`]),
			...(source.reason === undefined ? [] : [`reason: ${yaml(source.reason)}`]),
			"generated: vault-engine",
			"---",
		];
		const quotes = source.kind === "capture";
		const passages = Object.entries(source.passages).toSorted(([a], [b]) =>
			a.localeCompare(b, "en", { numeric: true }),
		);

		// A copied document usually opens with its own title.
		if (quotes || !passages.some(([, text]) => text.startsWith("# "))) {
			lines.push(`# ${literal(source.title)}`);
		}

		if (quotes && passages.length > 0) {
			lines.push("", "## Passages");
		}

		for (const [id, text] of passages) {
			if (quotes) {
				lines.push(`- ${literal(text.replaceAll(/\s*\n\s*/g, " "))} ^${id}`);
			} else {
				// A block ID on its own line, set off by blank lines, addresses the block above it.
				lines.push("", text.trimEnd(), "", `^${id}`);
			}
		}

		const citing = dependents.get(source.id) ?? [];

		lines.push("", "## Dependents");

		if (citing.length === 0) {
			lines.push("No claim cites this source yet.");
		}

		for (const { placed, link } of citing) {
			const flag = placed.claim.stale && placed.claim.status === "active" ? ", stale" : "";
			const where = link.passage === undefined ? "" : ` ^${link.passage}`;

			lines.push(
				`- [[${placed.note}#^${placed.claim.id}]] (${link.rel}${where}, ${placed.claim.status}${flag})`,
			);
		}

		files.set(`${tier}/Sources/${source.kind}/${source.id}.md`, `${lines.join("\n")}\n`);
	};

	for (const tier of tiers) {
		const state = view.tiers[tier];

		for (const topic of Object.values(state.topics)) {
			topicFile(tier, topic);
		}

		for (const source of Object.values(state.sources)) {
			sourceFile(tier, source);
		}
	}

	for (const [id, linkers] of inbound) {
		const placed = claims.get(id);
		const topics = new Set(
			linkers.filter((linker) => linker.note !== placed?.note).map((linker) => linker.note),
		);

		if (placed && topics.size >= PROMOTE_AT) {
			files.set(
				`${placed.tier}/Claims/${id}.md`,
				`${[
					"---",
					"type: claim",
					`tier: ${placed.tier}`,
					"generated: vault-engine",
					"---",
					`# Claim ${id}`,
					"",
					`![[${placed.note}#^${id}]]`,
					"",
					"## Linked from",
					...linkers.map((linker) => `- [[${linker.note}#^${linker.claim.id}]]`),
				].join("\n")}\n`,
			);
		}
	}

	const index = [
		"---",
		"type: index",
		"generated: vault-engine",
		"---",
		"# Vault",
		"",
		"This vault is generated from the vault engine. Edits made here are overwritten; write through the engine (`vault remember`).",
	];

	for (const tier of tiers) {
		const state = view.tiers[tier];
		index.push(
			"",
			`## ${tier}`,
			`${String(Object.keys(state.claims).length)} claims, ${String(Object.keys(state.sources).length)} sources.`,
			"",
			"### Topics",
			...Object.values(state.topics)
				.map((topic) => topicNote.get(`${tier}/${topic.id}`))
				.filter((name) => name !== undefined)
				.toSorted()
				.map((name) => `- [[${name}]]`),
		);
	}

	files.set("Index.md", `${index.join("\n")}\n`);

	return files;
}

const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

export interface ProjectResult {
	readonly notes: number;
}

/**
 * Regenerates the Obsidian vault in `out`. The new tree is written into a fresh folder this call
 * creates, then each owned entry (`Index.md` and one folder per tier) is renamed into place. A
 * rename replaces a symlink rather than following it, so no write or removal reaches outside `out`,
 * and anything else in the folder, such as `.obsidian/`, is left alone.
 */
export const project = Effect.fnUntraced(function* (out: string) {
	const fs = yield* FileSystem.FileSystem;
	const view = yield* (yield* Vault).view;
	const files = render(view, yield* now);

	yield* fs.makeDirectory(out, { recursive: true });

	yield* Effect.scoped(
		Effect.gen(function* () {
			const staging = yield* fs.makeTempDirectoryScoped({ directory: out, prefix: ".vault-new-" });
			const trash = yield* fs.makeTempDirectoryScoped({ directory: out, prefix: ".vault-old-" });

			for (const [relative, content] of files) {
				const file = path.join(staging, relative);

				yield* fs.makeDirectory(path.dirname(file), { recursive: true });
				yield* fs.writeFileString(file, content);
			}

			for (const entry of OWNED) {
				yield* ifExists(fs.rename(path.join(out, entry), path.join(trash, entry)));
				yield* ifExists(fs.rename(path.join(staging, entry), path.join(out, entry)));
			}
		}),
	);

	return { notes: files.size } satisfies ProjectResult;
});
