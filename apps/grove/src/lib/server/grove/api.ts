import { createEffectApi, operation } from "@petalnet/effect-api";
import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Effect } from "effect";

import {
	AttemptPublish,
	ClaimMutationReceipt,
	ClaimReceipt,
	ClaimRelease,
	ClaimRenew,
	ProjectCreate,
	ProjectCreateReceipt,
	ProjectPlan,
	ProjectPlanReceipt,
	PublishReceipt,
	ReadyTasks,
	ReviewReceipt,
	ReviewSubmit,
	TaskClaim,
	TaskComplete,
	TaskCompleteReceipt,
	WorkReady,
	LibrarySearch,
	LibrarySearchResults,
	LibraryGetVersion,
	LibraryVersion,
} from "../../projects/schema";
import {
	CreateSprout,
	EmptyInput,
	RemovedSprout,
	Sprout,
	SproutId,
	SproutList,
	WaterSprout,
} from "../../sprouts/schema";
import { AuthenticationRequired } from "../authorization";
import {
	CommandConflict,
	FenceConflict,
	ProjectDatabaseError,
	ProjectService,
} from "../projects/service";
import { SproutDatabaseError, SproutNotFound, SproutService } from "../sprouts/service";

type OperationError =
	| AuthenticationRequired
	| SproutNotFound
	| SproutDatabaseError
	| CommandConflict
	| FenceConflict
	| ProjectDatabaseError;

const statusForError = (error: OperationError): number => {
	if (error instanceof AuthenticationRequired) return 401;
	if (error instanceof CommandConflict || error instanceof FenceConflict) return 409;
	return error instanceof SproutNotFound ? 404 : 503;
};
const messageForError = (error: OperationError): string => {
	if (error instanceof AuthenticationRequired || error instanceof SproutNotFound)
		return error.message;
	if (error instanceof CommandConflict || error instanceof FenceConflict) return error.message;
	if (error instanceof ProjectDatabaseError) return "The project database is unavailable";
	return "The sprout database is unavailable";
};

const groveOperations = [
	operation({
		name: "project.create",
		description: "Create a Grove project Task and its initial immutable Version.",
		method: "POST",
		path: "/projects",
		input: ProjectCreate,
		output: ProjectCreateReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (service) => service.create(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "project.plan",
		description: "Accept a bounded child Task DAG.",
		method: "POST",
		path: "/projects/:projectId/plan",
		input: ProjectPlan,
		output: ProjectPlanReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.plan(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "task.claim",
		description: "Claim a ready Task and create an Attempt.",
		method: "POST",
		path: "/tasks/:taskId/claims",
		input: TaskClaim,
		output: ClaimReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.claim(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "claim.renew",
		description: "Renew an exact fenced Claim.",
		method: "POST",
		path: "/claims/:claimId/renew",
		input: ClaimRenew,
		output: ClaimMutationReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.renew(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "claim.release",
		description: "Release an exact fenced Claim.",
		method: "POST",
		path: "/claims/:claimId/release",
		input: ClaimRelease,
		output: ClaimMutationReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.release(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "attempt.publish",
		description: "Publish one immutable Attempt output.",
		method: "POST",
		path: "/attempts/:attemptId/outputs",
		input: AttemptPublish,
		output: PublishReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.publish(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "work.ready",
		description: "List visible ready Tasks in deterministic dependency order.",
		method: "GET",
		path: "/projects/:projectId/work/ready",
		input: WorkReady,
		output: ReadyTasks,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.ready(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "review.submit",
		description: "Review an exact submitted artifact Version.",
		method: "POST",
		path: "/reviews",
		input: ReviewSubmit,
		output: ReviewReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.review(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "task.complete",
		description: "Complete a Task whose exact Version contract is satisfied.",
		method: "POST",
		path: "/tasks/:taskId/complete",
		input: TaskComplete,
		output: TaskCompleteReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.complete(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "library.search",
		description: "Search accepted completed Project artifacts.",
		method: "GET",
		path: "/library/search",
		input: LibrarySearch,
		output: LibrarySearchResults,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.search(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "library.getVersion",
		description: "Retrieve one exact immutable accepted artifact Version with citations.",
		method: "GET",
		path: "/library/objects/:objectId/versions/:versionId",
		input: LibraryGetVersion,
		output: LibraryVersion,
		handler: (input) => Effect.flatMap(ProjectService, (s) => s.getVersion(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "sprouts.list",
		description: "List the dummy Grove sprouts.",
		method: "GET",
		path: "/sprouts",
		input: EmptyInput,
		output: SproutList,
		handler: () => Effect.flatMap(SproutService, (service) => service.list),
		statusForError,
		messageForError,
	}),
	operation({
		name: "sprouts.get",
		description: "Read one dummy Grove sprout.",
		method: "GET",
		path: "/sprouts/:id",
		input: SproutId,
		output: Sprout,
		handler: ({ id }) => Effect.flatMap(SproutService, (service) => service.get(id)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "sprouts.create",
		description: "Plant a dummy Grove sprout.",
		method: "POST",
		path: "/sprouts",
		input: CreateSprout,
		output: Sprout,
		handler: (input) => Effect.flatMap(SproutService, (service) => service.create(input)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "sprouts.water",
		description: "Water one dummy Grove sprout.",
		method: "POST",
		path: "/sprouts/:id/water",
		input: WaterSprout,
		output: Sprout,
		handler: ({ id }) => Effect.flatMap(SproutService, (service) => service.water(id)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "sprouts.remove",
		description: "Remove one dummy Grove sprout.",
		method: "DELETE",
		path: "/sprouts/:id",
		input: SproutId,
		output: RemovedSprout,
		handler: ({ id }) => Effect.flatMap(SproutService, (service) => service.remove(id)),
		statusForError,
		messageForError,
	}),
] as const;

export const groveApi = createEffectApi<SvelteKitRequestEvent | ProjectService | SproutService>({
	title: "Grove API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: groveOperations,
});
