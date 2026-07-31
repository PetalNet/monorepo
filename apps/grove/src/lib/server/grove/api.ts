import { createEffectApi, operation } from "@petalnet/effect-api";
import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Effect } from "effect";

import { ProjectCreate, ProjectCreateReceipt } from "../../projects/schema";
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
import { CommandConflict, ProjectDatabaseError, ProjectService } from "../projects/service";
import { SproutDatabaseError, SproutNotFound, SproutService } from "../sprouts/service";

type OperationError =
	| AuthenticationRequired
	| SproutNotFound
	| SproutDatabaseError
	| CommandConflict
	| ProjectDatabaseError;

const statusForError = (error: OperationError): number => {
	if (error instanceof AuthenticationRequired) return 401;
	if (error instanceof CommandConflict) return 409;
	return error instanceof SproutNotFound ? 404 : 503;
};
const messageForError = (error: OperationError): string => {
	if (error instanceof AuthenticationRequired || error instanceof SproutNotFound)
		return error.message;
	if (error instanceof CommandConflict) return error.message;
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
