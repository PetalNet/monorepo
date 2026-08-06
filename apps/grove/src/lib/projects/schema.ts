import { Schema } from "effect";

const boundedTrimmed = (maximum: number) =>
	Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const ProjectCreate = Schema.Struct({
	commandId: Schema.String.check(Schema.isUUID()),
	scope: boundedTrimmed(128),
	title: boundedTrimmed(256),
	ask: boundedTrimmed(4_000),
});
export type ProjectCreate = typeof ProjectCreate.Type;

export const ProjectCreateReceipt = Schema.Struct({
	commandId: Schema.String,
	objectId: Schema.String,
	versionId: Schema.String,
	versionDigest: Schema.String,
	replayed: Schema.Boolean,
});
export type ProjectCreateReceipt = typeof ProjectCreateReceipt.Type;

const Command = { commandId: Schema.String.check(Schema.isUUID()) };
const CompletionContract = Schema.Struct({
	requiredOutputs: Schema.Tuple([Schema.Literal("artifact")]),
	reviewRequired: Schema.Literal(true),
});
const PlannedTask = Schema.Struct({
	key: boundedTrimmed(32),
	title: boundedTrimmed(256),
	objective: boundedTrimmed(4_000),
	completionContract: CompletionContract,
});
const PlanDependency = Schema.Struct({
	task: boundedTrimmed(32),
	dependsOn: boundedTrimmed(32),
});
export const ProjectPlan = Schema.Struct({
	...Command,
	projectId: Schema.String,
	expectedVersionId: Schema.String,
	tasks: Schema.Array(PlannedTask).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
	dependencies: Schema.Array(PlanDependency).check(Schema.isMaxLength(6)),
});
export type ProjectPlan = typeof ProjectPlan.Type;
export const ProjectPlanReceipt = Schema.Struct({
	commandId: Schema.String,
	projectId: Schema.String,
	versionId: Schema.String,
	taskIds: Schema.Record(Schema.String, Schema.String),
	replayed: Schema.Boolean,
});
export type ProjectPlanReceipt = typeof ProjectPlanReceipt.Type;

export const TaskClaim = Schema.Struct({
	...Command,
	taskId: Schema.String,
	leaseSeconds: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 1, maximum: 3600 }),
	),
});
export const ClaimReceipt = Schema.Struct({
	commandId: Schema.String,
	taskId: Schema.String,
	attemptId: Schema.String,
	claimId: Schema.String,
	fence: Schema.String,
	expiresAt: Schema.String,
	replayed: Schema.Boolean,
});
export type TaskClaim = typeof TaskClaim.Type;
export type ClaimReceipt = typeof ClaimReceipt.Type;
const FencedCommand = { ...Command, claimId: Schema.String, fence: Schema.String };
export const ClaimRenew = Schema.Struct({
	...FencedCommand,
	leaseSeconds: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 1, maximum: 3600 }),
	),
});
export const ClaimRelease = Schema.Struct(FencedCommand);
export type ClaimRenew = typeof ClaimRenew.Type;
export type ClaimRelease = typeof ClaimRelease.Type;
export const ClaimMutationReceipt = Schema.Struct({
	commandId: Schema.String,
	claimId: Schema.String,
	expiresAt: Schema.NullOr(Schema.String),
	releasedAt: Schema.NullOr(Schema.String),
	replayed: Schema.Boolean,
});
export type ClaimMutationReceipt = typeof ClaimMutationReceipt.Type;
export const AttemptPublish = Schema.Struct({
	...FencedCommand,
	attemptId: Schema.String,
	title: boundedTrimmed(256),
	content: boundedTrimmed(20_000),
});
export type AttemptPublish = typeof AttemptPublish.Type;
export const PublishReceipt = Schema.Struct({
	commandId: Schema.String,
	attemptId: Schema.String,
	taskId: Schema.String,
	objectId: Schema.String,
	versionId: Schema.String,
	versionDigest: Schema.String,
	replayed: Schema.Boolean,
});
export type PublishReceipt = typeof PublishReceipt.Type;
export const WorkReady = Schema.Struct({ projectId: Schema.String });
const ReadyTask = Schema.Struct({
	taskId: Schema.String,
	title: Schema.String,
	dependencyTaskIds: Schema.Array(Schema.String),
});
export const ReadyTasks = Schema.Array(ReadyTask);
export type WorkReady = typeof WorkReady.Type;
export type ReadyTasks = typeof ReadyTasks.Type;

export const ReviewSubmit = Schema.Struct({
	...Command,
	taskId: Schema.String,
	attemptId: Schema.String,
	objectId: Schema.String,
	versionId: Schema.String,
	outcome: Schema.Literals(["accepted", "rejected"]),
	comments: Schema.optional(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4_000))),
});
export type ReviewSubmit = typeof ReviewSubmit.Type;
export const ReviewReceipt = Schema.Struct({
	commandId: Schema.String,
	reviewId: Schema.String,
	reviewVersionId: Schema.String,
	reviewDigest: Schema.String,
	taskId: Schema.String,
	attemptId: Schema.String,
	outcome: Schema.Literals(["accepted", "rejected"]),
	replayed: Schema.Boolean,
});
export type ReviewReceipt = typeof ReviewReceipt.Type;

export const TaskComplete = Schema.Struct({
	...Command,
	taskId: Schema.String,
	expectedVersionId: Schema.String,
});
export type TaskComplete = typeof TaskComplete.Type;
export const TaskCompleteReceipt = Schema.Struct({
	commandId: Schema.String,
	taskId: Schema.String,
	versionId: Schema.String,
	versionDigest: Schema.String,
	replayed: Schema.Boolean,
});
export type TaskCompleteReceipt = typeof TaskCompleteReceipt.Type;

export const LibrarySearch = Schema.Struct({
	projectId: Schema.String,
	query: boundedTrimmed(256),
	limit: Schema.optional(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
	),
});
const LibrarySearchResult = Schema.Struct({
	objectId: Schema.String,
	versionId: Schema.String,
	title: Schema.String,
	content: Schema.String,
	digest: Schema.String,
	taskId: Schema.String,
	attemptId: Schema.String,
	reviewId: Schema.String,
	reviewVersionId: Schema.String,
	reviewOutcome: Schema.Literal("accepted"),
	reviewerId: Schema.String,
	reviewerKind: Schema.String,
});
export const LibrarySearchResults = Schema.Array(LibrarySearchResult);
export type LibrarySearch = typeof LibrarySearch.Type;
export type LibrarySearchResults = typeof LibrarySearchResults.Type;

export const LibraryGetVersion = Schema.Struct({
	projectId: Schema.String,
	objectId: Schema.String,
	versionId: Schema.String,
});
export const LibraryVersion = Schema.Struct({
	objectId: Schema.String,
	versionId: Schema.String,
	payload: Schema.Record(Schema.String, Schema.Unknown),
	digest: Schema.String,
	authorId: Schema.String,
	authorKind: Schema.String,
	createdAt: Schema.String,
	taskId: Schema.String,
	attemptId: Schema.String,
	reviewId: Schema.String,
	reviewVersionId: Schema.String,
	reviewOutcome: Schema.Literal("accepted"),
	reviewerId: Schema.String,
	reviewerKind: Schema.String,
});
export type LibraryGetVersion = typeof LibraryGetVersion.Type;
export type LibraryVersion = typeof LibraryVersion.Type;
