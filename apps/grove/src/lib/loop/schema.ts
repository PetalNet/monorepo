import { Schema } from "effect";

const text = (maximum: number) =>
	Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const ProjectCreate = Schema.Struct({ title: text(256), ask: text(4_000) });
export const ProjectPlan = Schema.Struct({
	projectId: Schema.String,
	expectedVersionId: Schema.String,
	title: text(256),
	objective: text(4_000),
});
export const WorkReady = Schema.Struct({ projectId: Schema.String });
export const TaskClaim = Schema.Struct({ taskId: Schema.String });
export const AttemptPublish = Schema.Struct({
	attemptId: Schema.String,
	fence: Schema.String,
	title: text(256),
	content: text(20_000),
});
export const ReviewSubmit = Schema.Struct({
	attemptId: Schema.String,
	outcome: Schema.Literals(["accepted", "rejected"]),
	comments: Schema.optional(text(4_000)),
});
export const TaskComplete = Schema.Struct({
	taskId: Schema.String,
	expectedVersionId: Schema.String,
});
export const LibrarySearch = Schema.Struct({ projectId: Schema.String, query: text(256) });
