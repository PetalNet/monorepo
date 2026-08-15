import { createEffectApi, operation } from "@petalnet/effect-api";
import { Effect, Schema } from "effect";

import {
	AttemptPublish,
	LibrarySearch,
	ProjectCreate,
	ProjectPlan,
	ReviewSubmit,
	TaskClaim,
	TaskComplete,
	WorkReady,
} from "../../loop/schema";
import { ActorDenied, ActorNotCurrent } from "../actors/authority";
import { sproutOperations } from "../sprouts/api";
import type { SproutCommands } from "../sprouts/service";
import { LoopCommands, LoopConflict, LoopDatabaseError, type LoopError } from "./service";

const statusForError = (error: LoopError) =>
	error instanceof LoopConflict
		? 409
		: error instanceof ActorDenied || error instanceof ActorNotCurrent
			? 403
			: 503;
const messageForError = (error: LoopError) =>
	error instanceof LoopDatabaseError ? "The Grove loop database is unavailable" : error.message;
export const loopOperations = [
	operation({
		name: "project.create",
		description: "Create a project command.",
		method: "POST",
		path: "/projects",
		input: ProjectCreate,
		output: Schema.Unknown,
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.createProject(i)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "project.plan",
		description: "Plan one work task.",
		method: "POST",
		path: "/projects/:projectId/plan",
		input: ProjectPlan,
		output: Schema.Unknown,
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.planProject(i)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "work.ready",
		description: "List work ready for an agent.",
		method: "GET",
		path: "/projects/:projectId/work/ready",
		input: WorkReady,
		output: Schema.Array(Schema.Unknown),
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.readyWork(i)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "task.claim",
		description: "Claim ready work and create a fenced attempt.",
		method: "POST",
		path: "/tasks/:taskId/claim",
		input: TaskClaim,
		output: Schema.Unknown,
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.claimTask(i)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "attempt.publish",
		description: "Publish one attempt artifact.",
		method: "POST",
		path: "/attempts/:attemptId/publish",
		input: AttemptPublish,
		output: Schema.Unknown,
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.publishAttempt(i)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "review.submit",
		description: "Independently review an attempt.",
		method: "POST",
		path: "/reviews",
		input: ReviewSubmit,
		output: Schema.Unknown,
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.submitReview(i)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "task.complete",
		description: "Complete reviewed work at its expected Version.",
		method: "POST",
		path: "/tasks/:taskId/complete",
		input: TaskComplete,
		output: Schema.Unknown,
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.completeTask(i)),
		statusForError,
		messageForError,
	}),
	operation({
		name: "library.search",
		description: "Search accepted completed artifacts.",
		method: "GET",
		path: "/library/search",
		input: LibrarySearch,
		output: Schema.Array(Schema.Unknown),
		handler: (i) => Effect.flatMap(LoopCommands, (c) => c.searchLibrary(i)),
		statusForError,
		messageForError,
	}),
	...sproutOperations,
] as const;
export const loopApi = createEffectApi<
	LoopCommands | SproutCommands | import("../invocation").InvocationContext
>({
	title: "Grove agent loop API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: loopOperations,
});
