import { createHash } from "node:crypto";
import path from "node:path";

import { Clock, Effect, FileSystem, Option, Schema } from "effect";

import { Vault } from "./engine.ts";
import type { VaultView } from "./engine.ts";
import { freshness, tiers } from "./schema.ts";
import type { Claim, Link, Source, Tier, Topic } from "./schema.ts";
import { ifExists } from "./store.ts";

/** A claim promoted to its own note once claims in this many other topics link to it. */
const PROMOTE_AT = 3;

/** Digests of the files the last projection wrote, for spotting hand edits. */
const MANIFEST = ".vault-projection.json";

/** Everything the projection owns in the folder. The rest of the folder is left alone. */
const OWNED = ["Index.md", MANIFEST, ...tiers];

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

/** Tracks CommonMark code fences, line by line. */
class Fence {
	#open: { char: string; length: number } | undefined;
	/** Feeds one line; returns true if the line is markdown, outside any fence. */
	feed(line: string): boolean {
		// A backtick fence's info string cannot itself contain a backtick.
		const run = /^ {0,3}(`{3,}(?!.*`)|~{3,})(.*)$/.exec(line);

		if (this.#open) {
			if (
				run?.[1]?.startsWith(this.#open.char) === true &&
				run[1].length >= this.#open.length &&
				run[2]?.trim() === ""
			) {
				this.#open = undefined;
			}

			return false;
		}

		if (run?.[1] !== undefined) {
			this.#open = { char: run[1].charAt(0), length: run[1].length };

			return false;
		}

		return true;
	}
	/** The line that closes a fence still open, if one is. */
	get closer(): string | undefined {
		return this.#open?.char.repeat(this.#open.length);
	}
}

/**
 * A copied passage stays markdown but cannot hide what follows it: outside code, `<` and `%%` are
 * escaped, so no HTML block or comment can open, and a fence left open is closed after it.
 */
function contain(text: string): string {
	const fence = new Fence();
	const lines = text
		.split("\n")
		.map((line) =>
			fence.feed(line)
				? line.replaceAll(
						/(`[^`]*`)|<|%%/g,
						(match, code: string | undefined) =>
							code ?? (match === "<" ? String.raw`\<` : String.raw`%\%`),
					)
				: line,
		);

	return [...lines, ...(fence.closer === undefined ? [] : [fence.closer])].join("\n");
}

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

		if (claim.verdict !== undefined) {
			fields.push(`[verdict:: ${claim.verdict}]`);
		}

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
				lines.push("", contain(text.trimEnd()), "", `^${id}`);
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
		"This vault is generated from the vault engine. Edits made here are overwritten; write through the engine (`vault remember`, `vault research-run`).",
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
	readonly changed: number;
	readonly removed: number;
	/** Notes whose content on disk was not what the last projection wrote. */
	readonly overwrittenEdits: readonly string[];
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

/**
 * Regenerates the Obsidian vault in `out`. The new tree is written into a fresh folder this call
 * creates, then each owned entry (`Index.md`, the manifest, one folder per tier) is renamed into
 * place. A rename replaces a symlink rather than following it, so no write or removal reaches
 * outside `out`, and anything else in the folder, such as `.obsidian/`, is left alone.
 */
export const project = Effect.fnUntraced(function* (out: string) {
	const fs = yield* FileSystem.FileSystem;
	const view = yield* (yield* Vault).view;
	const files = render(view, yield* now);

	yield* fs.makeDirectory(out, { recursive: true });

	const previous = yield* fs.readFileString(path.join(out, MANIFEST)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
		Effect.orElseSucceed((): Record<string, string> => ({})),
	);
	const manifest = Object.fromEntries(
		[...files].map(([relative, content]) => [relative, digest(content)]),
	);
	const overwrittenEdits: string[] = [];

	// Only names this projection generates are read back, never a path taken from the manifest.
	for (const relative of files.keys()) {
		const before = previous[relative];
		const onDisk = Option.getOrUndefined(
			yield* ifExists(fs.readFileString(path.join(out, relative))),
		);

		if (before !== undefined && onDisk !== undefined && digest(onDisk) !== before) {
			overwrittenEdits.push(relative);
		}
	}

	yield* Effect.scoped(
		Effect.gen(function* () {
			const staging = yield* fs.makeTempDirectoryScoped({ directory: out, prefix: ".vault-new-" });
			const trash = yield* fs.makeTempDirectoryScoped({ directory: out, prefix: ".vault-old-" });

			for (const [relative, content] of files) {
				const file = path.join(staging, relative);

				yield* fs.makeDirectory(path.dirname(file), { recursive: true });
				yield* fs.writeFileString(file, content);
				// Read-only files make an editor refuse a hand edit instead of losing it on the next run.
				// An ACL-managed share may refuse chmod; the manifest still catches the edit.
				yield* fs.chmod(file, 0o444).pipe(Effect.ignore);
			}

			yield* fs.writeFileString(path.join(staging, MANIFEST), JSON.stringify(manifest));

			for (const entry of OWNED) {
				yield* ifExists(fs.rename(path.join(out, entry), path.join(trash, entry)));
				yield* ifExists(fs.rename(path.join(staging, entry), path.join(out, entry)));
			}
		}),
	);

	return {
		notes: files.size,
		changed: [...files.keys()].filter((relative) => previous[relative] !== manifest[relative])
			.length,
		removed: Object.keys(previous).filter((relative) => !files.has(relative)).length,
		overwrittenEdits,
	} satisfies ProjectResult;
});

export interface LintResult {
	readonly files: number;
	readonly claimBlocks: number;
	readonly links: number;
	readonly problems: readonly string[];
}

const GENERATED_LINK = /!?\[\[([^\]|#]*)(?:#\^([A-Za-z0-9-]+))?(?:\|[^\]]*)?\]\]/g;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)$/;

/**
 * Checks a projected vault from its files: every claim ID the engine holds appears as exactly one
 * block, every passage is a visible block, and every generated wikilink resolves to a note and,
 * when it names one, a block in that note. Text copied from migrated documents is not
 * link-checked.
 */
export const lint = Effect.fnUntraced(function* (out: string) {
	const fs = yield* FileSystem.FileSystem;
	const view = yield* (yield* Vault).view;
	const notes = new Map<string, { relative: string; blocks: Set<string>; lines: string[] }>();
	const problems: string[] = [];
	const seen = new Map<string, string>();
	let claimBlocks = 0;
	let links = 0;

	const tierNotes = yield* Effect.forEach(tiers, (tier) =>
		fs.readDirectory(path.join(out, tier), { recursive: true }).pipe(
			Effect.map((entries) => entries.map((entry) => `${tier}/${entry}`)),
			Effect.orElseSucceed((): string[] => []),
		),
	);

	for (const relative of ["Index.md", ...tierNotes.flat()]
		.filter((entry) => entry.endsWith(".md"))
		.toSorted()) {
		const lines = (yield* fs.readFileString(path.join(out, relative))).split("\n");
		const blocks = new Set<string>();
		const fence = new Fence();
		const body = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
		let dependents = false;

		for (const line of lines.slice(body)) {
			// A block ID or heading inside a fence is text to Obsidian, not structure.
			if (!fence.feed(line)) {
				continue;
			}

			dependents ||= line === "## Dependents";

			const id = BLOCK_ID.exec(line)?.[1];

			if (id === undefined) {
				continue;
			}

			blocks.add(id);

			if (id.startsWith("c-") && relative.includes("/Topics/")) {
				claimBlocks++;

				if (seen.has(id)) {
					problems.push(`claim ${id} appears in both ${seen.get(id) ?? ""} and ${relative}`);
				}

				seen.set(id, relative);
			}
		}

		if (relative.includes("/Sources/") && !dependents) {
			problems.push(`${relative}: the Dependents list is hidden by an unclosed fence`);
		}

		notes.set(path.basename(relative, ".md").toLowerCase(), { relative, blocks, lines });
	}

	for (const tier of tiers) {
		for (const id of Object.keys(view.tiers[tier].claims)) {
			if (!seen.has(id)) {
				problems.push(`claim ${id} is missing from the projection`);
			}
		}

		for (const source of Object.values(view.tiers[tier].sources)) {
			const note = notes.get(source.id);

			for (const id of Object.keys(source.passages)) {
				if (note && !note.blocks.has(id)) {
					problems.push(`${note.relative}: passage ^${id} is not a visible block`);
				}
			}
		}
	}

	for (const { relative, lines } of notes.values()) {
		// In a source note only the generated tail is checked; the body above is copied text.
		const start = relative.includes("/Sources/") ? lines.lastIndexOf("## Dependents") : 0;

		for (const line of lines.slice(Math.max(start, 0))) {
			for (const [, name = "", block] of line.matchAll(GENERATED_LINK)) {
				const found = notes.get(
					(name === "" ? path.basename(relative, ".md") : name).toLowerCase(),
				);

				links++;

				if (!found) {
					problems.push(`${relative}: link to missing note [[${name}]]`);
				} else if (block !== undefined && !found.blocks.has(block)) {
					problems.push(`${relative}: link to missing block [[${name}#^${block}]]`);
				}
			}
		}
	}

	return { files: notes.size, claimBlocks, links, problems } satisfies LintResult;
});
