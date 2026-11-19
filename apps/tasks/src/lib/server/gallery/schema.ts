import { Schema } from "effect";

import { Pull } from "./github.ts";

/** Where on the page an answer points. The page defines the shape; the platform stores it. */
const Anchor = Schema.Record(Schema.String, Schema.Unknown);

export const SendFeedback = Schema.Struct({
	slug: Schema.String,
	anchor: Anchor,
	/** Opaque to the platform: the page defines what an answer is. */
	payload: Schema.Unknown,
	ink: Schema.optional(Schema.Unknown),
	crop: Schema.optional(Schema.String),
});

export const Sent = Schema.Struct({
	id: Schema.Int,
	rev: Schema.Int,
	/** Null when the Matrix post failed; the row is stored either way. */
	matrixEventId: Schema.NullOr(Schema.String),
});

export const NeedsYouItem = Schema.Struct({
	slug: Schema.String,
	title: Schema.String,
	collection: Schema.String,
	rev: Schema.Int,
	updated_at: Schema.String,
});

export const NeedsYou = Schema.Struct({});

const FeedbackItem = Schema.Struct({
	id: Schema.Int,
	rev: Schema.Int,
	status: Schema.Literals(["sent", "seen", "resolved"]),
	resolution: Schema.NullOr(Schema.String),
	resolved_rev: Schema.NullOr(Schema.Int),
	payload: Schema.Unknown,
});

export const ArtifactState = Schema.Struct({
	rev: Schema.Int,
	updated_at: Schema.String,
	feedback: Schema.Array(FeedbackItem),
});

export const StateRequest = Schema.Struct({ slug: Schema.String });

/** Which view of the gallery: the viewer's own, everything, one project, or one piece of work. */
export const OngoingRequest = Schema.Struct({
	project: Schema.optional(Schema.String),
	work: Schema.optional(Schema.String),
	/** Without a project the list is the viewer's own; "all" lifts that. */
	show: Schema.optional(Schema.Literals(["all"])),
});

/** Follow a project, hide it, or (null) go back to following the viewer's involvement. */
export const ChooseProject = Schema.Struct({
	project: Schema.String,
	choice: Schema.NullOr(Schema.Literals(["follow", "hide"])),
});

export const OpenedProject = Schema.Struct({ project: Schema.String });

export const Done = Schema.Struct({});

const OngoingPull = Schema.Struct({
	...Pull.fields,
	/** How many pages the viewer can see that link to this pull request. */
	pages: Schema.Int,
});

/** What is in motion in one view of the gallery. */
export const Ongoing = Schema.Struct({
	/** "off": no search is configured. "unavailable": GitHub did not answer, so `pulls` is empty. */
	github: Schema.Literals(["ok", "unavailable", "off"]),
	pulls: Schema.Array(OngoingPull),
	/** Pull requests the viewer's own view leaves out; `show=all` lists them. */
	more: Schema.Int,
	/** Pages with answers nobody has resolved yet. */
	answers: Schema.Array(
		Schema.Struct({
			slug: Schema.String,
			title: Schema.String,
			collection: Schema.String,
			count: Schema.Int,
			latest: Schema.String,
		}),
	),
});

export type Ongoing = typeof Ongoing.Type;
