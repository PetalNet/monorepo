import { Schema } from "effect";

/** One Loro document per tier; a tier's history can never leak into another tier's file. */
export const Tier = Schema.Literals(["shared", "personal", "agent"]).annotate({
	description:
		"Sensitivity tier. shared: research and lab knowledge. personal: the owner's personal data. agent: an agent's own working memory.",
});
export type Tier = typeof Tier.Type;
export const tiers = Tier.literals;

const SourceType = Schema.Literals(["PRIMARY", "DIRECT", "DERIVED", "GUESS"]);

const pattern = (regExp: RegExp) => Schema.String.check(Schema.isPattern(regExp));

// Obsidian block IDs accept only letters, digits and hyphens.
const ClaimId = pattern(/^c-[a-z0-9]{8}$/);
const TopicId = pattern(/^t-[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Timestamp = pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

export const Text = Schema.NonEmptyString;

const Line = Text.check(
	Schema.makeFilter((value: string) => !/[\r\n]/.test(value) || "must be a single line"),
);

export const Claim = Schema.Struct({
	id: ClaimId,
	text: Line,
	topic: TopicId,
	heading: Line,
	sourceType: SourceType,
	created: Timestamp,
	agent: Text,
});
export type Claim = typeof Claim.Type;

export const Topic = Schema.Struct({
	id: TopicId,
	title: Line,
	summary: Line,
	/** Heading order in the projected note. Headings not listed sort after these. */
	headings: Schema.Array(Line),
});
export type Topic = typeof Topic.Type;

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
