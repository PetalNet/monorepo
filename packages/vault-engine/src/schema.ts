import { Schema } from "effect";

/** One Loro document per tier; a tier's history can never leak into another tier's file. */
export const Tier = Schema.Literals(["shared", "personal", "agent"]).annotate({
	description:
		"Sensitivity tier. shared: research and lab knowledge. personal: the owner's personal data. agent: an agent's own working memory.",
});
export type Tier = typeof Tier.Type;
export const tiers = Tier.literals;

export const SourceType = Schema.Literals(["PRIMARY", "DIRECT", "DERIVED", "GUESS"]);
export const Relation = Schema.Literals(["source", "supports", "contradicts", "replaces"]);
export const Verdict = Schema.Literals(["supported", "mixed", "contradicted", "new"]);

const pattern = (regExp: RegExp) => Schema.String.check(Schema.isPattern(regExp));

// Obsidian block IDs accept only letters, digits and hyphens.
const ClaimId = pattern(/^c-[a-z0-9]{8}$/);
const SourceId = pattern(/^(?:src|doc)-[a-z0-9]{8,40}$/);
const TopicId = pattern(/^t-[a-z0-9]+(?:-[a-z0-9]+)*$/);
const RunId = pattern(/^run-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/);
const PassageId = pattern(/^[a-z][a-z0-9-]{0,30}$/);
const Timestamp = pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const Url = Schema.String.check(
	Schema.makeFilter((value: string) => URL.canParse(value) || "must be a URL"),
);

export const Text = Schema.NonEmptyString;

const Line = Text.check(
	Schema.makeFilter((value: string) => !/[\r\n]/.test(value) || "must be a single line"),
);
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** A typed wikilink from a claim to a source passage or to another claim. */
export const Link = Schema.Struct({
	rel: Relation,
	target: Schema.Union([SourceId, ClaimId]),
	passage: Schema.optionalKey(PassageId),
});
export type Link = typeof Link.Type;

export const Claim = Schema.Struct({
	id: ClaimId,
	text: Line,
	topic: TopicId,
	heading: Line,
	links: Schema.Array(Link),
	sourceType: SourceType,
	status: Schema.Literals(["active", "superseded", "retracted"]),
	supersededBy: Schema.optionalKey(ClaimId),
	reason: Schema.optionalKey(Line),
	verdict: Schema.optionalKey(Verdict),
	/** Set when a cited source was replaced or retracted. */
	stale: Schema.optionalKey(
		Schema.Struct({
			since: Timestamp,
			sources: Schema.Array(SourceId).check(Schema.isMinLength(1)),
		}),
	),
	created: Timestamp,
	updated: Timestamp,
	agent: Text,
	run: Schema.optionalKey(RunId),
}).check(
	Schema.makeFilter(
		(claim) =>
			claim.sourceType === "GUESS" ||
			claim.links.some((link) => link.rel === "source" || link.rel === "supports") ||
			"a claim that is not a GUESS needs a source:: or supports:: link",
	),
);
export type Claim = typeof Claim.Type;

const SourceKind = Schema.Literals([
	"capture",
	"direct",
	"research",
	"memory",
	"gallery",
	"context",
]);

export const Source = Schema.Struct({
	id: SourceId,
	/**
	 * `capture` is a vault-cite artifact, `direct` records who said or observed something; the rest
	 * are lab documents copied in verbatim.
	 */
	kind: SourceKind,
	title: Line,
	url: Schema.optionalKey(Url),
	sourceType: SourceType,
	captured: Timestamp,
	shelfLifeDays: Schema.optionalKey(PositiveInt),
	status: Schema.Literals(["active", "replaced", "retracted"]),
	replacedBy: Schema.optionalKey(SourceId),
	reason: Schema.optionalKey(Line),
	/** Passage ID to passage text. The heading a passage sits under is `headings[id]`. */
	passages: Schema.Record(PassageId, Text),
	headings: Schema.optionalKey(Schema.Record(PassageId, Line)),
	agent: Text,
});
export type Source = typeof Source.Type;

export const Topic = Schema.Struct({
	id: TopicId,
	title: Line,
	summary: Line,
	hub: Schema.optionalKey(TopicId),
	shelfLifeDays: Schema.optionalKey(PositiveInt),
	/** Heading order in the projected note. Headings not listed sort after these. */
	headings: Schema.Array(Line),
});
export type Topic = typeof Topic.Type;

export const Gap = Schema.Struct({ ref: Line, reason: Line });

const Ref = Schema.Union([ClaimId, SourceId]);

export const Run = Schema.Struct({
	id: RunId,
	question: Line,
	summary: Text,
	date: Timestamp,
	agent: Text,
	topics: Schema.Array(TopicId),
	answer: Schema.Array(ClaimId),
	created: Schema.Array(Ref),
	updated: Schema.Array(Ref),
	reused: Schema.Array(Ref),
	stale: Schema.Array(Ref),
	gaps: Schema.Array(Gap),
});
export type Run = typeof Run.Type;

const DEFAULT_SHELF_LIFE_DAYS = 365;

/** A source goes stale once it is older than its shelf life; replacement and retraction win. */
export function freshness(source: Source, topicShelfLifeDays: number | undefined, now: Date) {
	if (source.status !== "active") {
		return source.status;
	}

	const days = source.shelfLifeDays ?? topicShelfLifeDays ?? DEFAULT_SHELF_LIFE_DAYS;
	const age = now.getTime() - new Date(source.captured).getTime();

	return age > days * 86_400_000 ? "stale" : "fresh";
}

export function slug(text: string): string {
	const value = text
		.normalize("NFKD")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");

	return value || "untitled";
}

export const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();
