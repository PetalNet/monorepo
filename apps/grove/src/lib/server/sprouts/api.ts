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
import { ActorDenied, ActorNotCurrent } from "../actors/authority";
import { SproutCommands, SproutNotFound, type SproutError } from "./service";

const statusForError = (error: SproutError): number => {
	if (error instanceof ActorDenied || error instanceof ActorNotCurrent) return 403;
	return error instanceof SproutNotFound ? 404 : 503;
};
const messageForError = (error: SproutError): string => {
	if (
		error instanceof SproutNotFound ||
		error instanceof ActorDenied ||
		error instanceof ActorNotCurrent
	)
		return error.message;
	return "The sprout database is unavailable";
};

export const sproutOperations = [
	operation({
		name: "sprouts.list",
		description: "List the dummy Grove sprouts.",
		method: "GET",
		path: "/sprouts",
		input: EmptyInput,
		output: SproutList,
		handler: () => Effect.flatMap(SproutCommands, (commands) => commands.list),
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
		handler: ({ id }) => Effect.flatMap(SproutCommands, (commands) => commands.get(id)),
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
		handler: (input) => Effect.flatMap(SproutCommands, (commands) => commands.create(input)),
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
		handler: ({ id }) => Effect.flatMap(SproutCommands, (commands) => commands.water(id)),
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
		handler: ({ id }) => Effect.flatMap(SproutCommands, (commands) => commands.remove(id)),
		statusForError,
		messageForError,
	}),
] as const;

export const sproutApi = createEffectApi({
	title: "Grove sprouts API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: sproutOperations,
});
