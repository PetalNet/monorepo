import { Schema } from "effect";

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

/** Which view of the gallery: everything, one project, or one piece of work in it. */
export const OngoingRequest = Schema.Struct({
	project: Schema.optional(Schema.String),
	work: Schema.optional(Schema.String),
});

const OngoingPull = Schema.Struct({
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
	reviewers: Schema.Array(Schema.String),
	pages: Schema.Int,
});

export const Ongoing = Schema.Struct({
	github: Schema.Literals(["ok", "unavailable", "off"]),
	pulls: Schema.Array(OngoingPull),
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
