import { createEffectApi, operation } from "@petalnet/effect-api";
import { Effect } from "effect";

import {
	CreateSprout,
	EmptyInput,
	RemovedSprout,
	Sprout,
	SproutId,
	SproutList,
	WaterSprout,
} from "../../sprouts/schema";
import { SproutDatabaseError, SproutNotFound, SproutService } from "./service";

const databaseStatus = (_error: SproutDatabaseError): number => 503;
const persistedStatus = (error: SproutNotFound | SproutDatabaseError): number =>
	error instanceof SproutNotFound ? 404 : 503;
const databaseMessage = (_error: SproutDatabaseError): string =>
	"The sprout database is unavailable";
const persistedMessage = (error: SproutNotFound | SproutDatabaseError): string =>
	error instanceof SproutNotFound ? error.message : databaseMessage(error);

const sproutOperations = [
	operation({
		name: "sprouts.list",
		description: "List the dummy Grove sprouts.",
		method: "GET",
		path: "/sprouts",
		input: EmptyInput,
		output: SproutList,
		handler: () => Effect.flatMap(SproutService, (service) => service.list),
		statusForError: databaseStatus,
		messageForError: databaseMessage,
	}),
	operation({
		name: "sprouts.get",
		description: "Read one dummy Grove sprout.",
		method: "GET",
		path: "/sprouts/:id",
		input: SproutId,
		output: Sprout,
		handler: ({ id }) => Effect.flatMap(SproutService, (service) => service.get(id)),
		statusForError: persistedStatus,
		messageForError: persistedMessage,
	}),
	operation({
		name: "sprouts.create",
		description: "Plant a dummy Grove sprout.",
		method: "POST",
		path: "/sprouts",
		input: CreateSprout,
		output: Sprout,
		handler: (input) => Effect.flatMap(SproutService, (service) => service.create(input)),
		statusForError: databaseStatus,
		messageForError: databaseMessage,
	}),
	operation({
		name: "sprouts.water",
		description: "Water one dummy Grove sprout.",
		method: "POST",
		path: "/sprouts/:id/water",
		input: WaterSprout,
		output: Sprout,
		handler: ({ id }) => Effect.flatMap(SproutService, (service) => service.water(id)),
		statusForError: persistedStatus,
		messageForError: persistedMessage,
	}),
	operation({
		name: "sprouts.remove",
		description: "Remove one dummy Grove sprout.",
		method: "DELETE",
		path: "/sprouts/:id",
		input: SproutId,
		output: RemovedSprout,
		handler: ({ id }) => Effect.flatMap(SproutService, (service) => service.remove(id)),
		statusForError: persistedStatus,
		messageForError: persistedMessage,
	}),
] as const;

export const sproutApi = createEffectApi({
	title: "Grove sprouts API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: sproutOperations,
});
