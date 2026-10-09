import { operation } from "@petalnet/effect-api";
import { Effect, Match } from "effect";

import { ProjectCreate, ProjectCreateReceipt } from "../../projects/schema";
import { ProjectService } from "./service";

export const projectOperations = [
	operation({
		name: "project.create",
		description: "Create a Grove project Task and its initial immutable Version.",
		method: "POST",
		path: "/projects",
		input: ProjectCreate,
		output: ProjectCreateReceipt,
		handler: (input) => Effect.flatMap(ProjectService, (service) => service.create(input)),
		statusForError: (error) =>
			Match.value(error).pipe(
				Match.tagsExhaustive({
					ActorDenied: () => 403,
					ActorNotCurrent: () => 403,
					CommandConflict: () => 409,
					ActorDatabaseError: () => 503,
					HomeOwnerUnbound: () => 503,
					CapabilityContainmentConflict: () => 503,
					ProjectDatabaseError: () => 503,
				}),
			),
		messageForError: (error) =>
			Match.value(error).pipe(
				Match.tagsExhaustive({
					ActorDenied: (failure) => failure.message,
					ActorNotCurrent: (failure) => failure.message,
					CommandConflict: (failure) => failure.message,
					ActorDatabaseError: () => "The project database is unavailable",
					HomeOwnerUnbound: () => "The project database is unavailable",
					CapabilityContainmentConflict: () => "The project database is unavailable",
					ProjectDatabaseError: () => "The project database is unavailable",
				}),
			),
	}),
];
