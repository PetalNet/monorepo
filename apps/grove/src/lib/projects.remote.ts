import { form, getRequestEvent, query, requested } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { Effect, Schema } from "effect";

import {
	CompleteTaskValidator,
	CreateProjectValidator,
	FindArtifactsValidator,
	OpenProjectValidator,
	PlanTaskValidator,
	ReviewOutputValidator,
} from "./projects/forms";
import { LibraryGetVersion, LibrarySearch, WorkReady } from "./projects/schema";
import { withBrowserInvocation } from "./server/invocation";
import { ProjectService } from "./server/projects/service";
import { runGrove } from "./server/runtime";

export const readyWork = query(Schema.toStandardSchemaV1(WorkReady), (input) =>
	runGrove(
		withBrowserInvocation(Effect.flatMap(ProjectService, (service) => service.ready(input))),
		getRequestEvent(),
	),
);

export const searchLibrary = query(Schema.toStandardSchemaV1(LibrarySearch), (input) =>
	runGrove(
		withBrowserInvocation(Effect.flatMap(ProjectService, (service) => service.search(input))),
		getRequestEvent(),
	),
);

export const getArtifactVersion = query(Schema.toStandardSchemaV1(LibraryGetVersion), (input) =>
	runGrove(
		withBrowserInvocation(Effect.flatMap(ProjectService, (service) => service.getVersion(input))),
		getRequestEvent(),
	),
);

export const openProject = form(OpenProjectValidator, ({ projectId, view }) =>
	redirect(303, `/?${new URLSearchParams({ project: projectId, view })}`),
);

export const findArtifacts = form(FindArtifactsValidator, ({ projectId, query: search }) =>
	redirect(303, `/?${new URLSearchParams({ project: projectId, view: "library", query: search })}`),
);

export const refreshWork = form(Schema.toStandardSchemaV1(WorkReady), async (input) => {
	await readyWork(input).refresh();
});

export const createProject = form(CreateProjectValidator, async (input) => {
	const receipt = await runGrove(
		withBrowserInvocation(Effect.flatMap(ProjectService, (service) => service.create(input))),
		getRequestEvent(),
	);

	await Promise.all([
		requested(readyWork, 1).refreshAll(),
		requested(searchLibrary, 1).refreshAll(),
	]);

	return redirect(303, `/?project=${receipt.objectId}&version=${receipt.versionId}`);
});

export const planTask = form(PlanTaskValidator, async (input) => {
	const { commandId, projectId, expectedVersionId, title, objective } = input;
	const receipt = await runGrove(
		withBrowserInvocation(
			Effect.flatMap(ProjectService, (service) =>
				service.plan({
					commandId,
					projectId,
					expectedVersionId,
					tasks: [
						{
							key: "work",
							title,
							objective,
							completionContract: { requiredOutputs: ["artifact"], reviewRequired: true },
						},
					],
					dependencies: [],
				}),
			),
		),
		getRequestEvent(),
	);

	await Promise.all([
		requested(readyWork, 1).refreshAll(),
		requested(searchLibrary, 1).refreshAll(),
	]);

	return receipt;
});

export const reviewOutput = form(ReviewOutputValidator, async (input) => {
	const { commandId, taskId, attemptId, objectId, versionId, outcome, comments } = input;
	const receipt = await runGrove(
		withBrowserInvocation(
			Effect.flatMap(ProjectService, (service) =>
				service.review({
					commandId,
					taskId,
					attemptId,
					objectId,
					versionId,
					outcome,
					...(comments === "" ? {} : { comments }),
				}),
			),
		),
		getRequestEvent(),
	);

	await Promise.all([
		requested(readyWork, 1).refreshAll(),
		requested(searchLibrary, 1).refreshAll(),
		requested(getArtifactVersion, 1).refreshAll(),
	]);

	return receipt;
});

export const completeTask = form(CompleteTaskValidator, async (input) => {
	const { commandId, taskId, expectedVersionId } = input;
	const receipt = await runGrove(
		withBrowserInvocation(
			Effect.flatMap(ProjectService, (service) =>
				service.complete({ commandId, taskId, expectedVersionId }),
			),
		),
		getRequestEvent(),
	);

	await Promise.all([
		requested(readyWork, 1).refreshAll(),
		requested(searchLibrary, 1).refreshAll(),
		requested(getArtifactVersion, 1).refreshAll(),
	]);

	return receipt;
});
