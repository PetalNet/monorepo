import { operation, operationError, type OperationErrors } from "@petalnet/effect-api";
import { createServer, SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import {
	ArtifactNotFound,
	AuthenticationRequired,
	Feedback,
	FeedbackLive,
	NotAskedHere,
	PayloadTooLarge,
	StoreError,
	Viewer,
} from "./feedback.ts";
import { GitHubLive } from "./github.ts";
import { choose, opened, ProjectNotFound } from "./interest.ts";
import { MatrixPosterLive } from "./matrix.ts";
import { ongoing } from "./ongoing.ts";
import {
	ArtifactState,
	ChooseProject,
	Done,
	NeedsYou,
	NeedsYouItem,
	Ongoing,
	OngoingRequest,
	OpenedProject,
	SendFeedback,
	Sent,
	StateRequest,
} from "./schema.ts";

const feedbackErrors = {
	ArtifactNotFound: operationError(ArtifactNotFound, { status: 404, message: "No such artifact" }),
	NotAskedHere: operationError(NotAskedHere, {
		status: 403,
		message: "This page is not asking you anything",
	}),
	PayloadTooLarge: operationError(PayloadTooLarge, {
		status: 413,
		message: "That answer is too large",
	}),
	StoreError: operationError(StoreError, {
		status: 503,
		message: "The gallery database is unavailable",
	}),
} satisfies OperationErrors<ArtifactNotFound | NotAskedHere | PayloadTooLarge | StoreError>;

const authenticationErrors = {
	AuthenticationRequired: operationError(AuthenticationRequired, {
		status: 401,
		message: "Authentication required",
	}),
} satisfies OperationErrors<AuthenticationRequired>;

/** Behind Authentik the proxy sets the username; hooks.server.js copies it to locals.user. */
const browserAuthentication = Effect.gen(function* () {
	const event = yield* SvelteKitRequestEvent;
	const user = event.locals.user;

	if (!user) {
		return yield* new AuthenticationRequired();
	}

	return Context.make(Viewer, { user });
});

const sendFeedback = operation({
	name: "feedback.send",
	description: "Answer a question a published page asks the signed-in viewer.",
	method: "POST",
	path: "/artifacts/:slug/feedback",
	input: SendFeedback,
	output: Sent,
	handler: (input) => Effect.flatMap(Feedback, (feedback) => feedback.send(input)),
	errors: feedbackErrors,
});

const needsYou = operation({
	name: "feedback.needs_you",
	description: "List the pages that ask the signed-in viewer something they have not answered.",
	method: "GET",
	path: "/needs-you",
	input: NeedsYou,
	output: Schema.Array(NeedsYouItem),
	handler: () => Effect.flatMap(Feedback, (feedback) => feedback.needsYou),
	errors: feedbackErrors,
});

const artifactState = operation({
	name: "feedback.state",
	description: "The current revision of a page and the viewer's own answers on it.",
	method: "GET",
	path: "/artifacts/:slug/state",
	input: StateRequest,
	output: ArtifactState,
	handler: ({ slug }) => Effect.flatMap(Feedback, (feedback) => feedback.state(slug)),
	errors: feedbackErrors,
});

const listOngoing = operation({
	name: "ongoing.list",
	description:
		"What is in motion: open pull requests with their checks and review state, and pages with unresolved answers.",
	method: "GET",
	path: "/ongoing",
	input: OngoingRequest,
	output: Ongoing,
	handler: ongoing,
	errors: { StoreError: feedbackErrors.StoreError },
});

const projectErrors = {
	ProjectNotFound: operationError(ProjectNotFound, { status: 404, message: "No such project" }),
	StoreError: feedbackErrors.StoreError,
} satisfies OperationErrors<ProjectNotFound | StoreError>;

const chooseProject = operation({
	name: "projects.choose",
	description:
		"Follow or hide a project for the signed-in viewer, or clear the choice so it follows their involvement.",
	method: "PUT",
	path: "/projects/:project/choice",
	input: ChooseProject,
	output: Done,
	handler: ({ project, choice }) => Effect.as(choose(project, choice), {}),
	errors: projectErrors,
});

const openedProject = operation({
	name: "projects.opened",
	description: "Record that the signed-in viewer went to a project or one of its pages.",
	method: "POST",
	path: "/projects/:project/opened",
	input: OpenedProject,
	output: Done,
	handler: ({ project }) => Effect.as(opened(project), {}),
	errors: projectErrors,
});

const services = Layer.merge(FeedbackLive.pipe(Layer.provide(MatrixPosterLive)), GitHubLive).pipe(
	Layer.provide(FetchHttpClient.layer),
);

/** The gallery's one HTTP application: REST under /api/v1 and the services behind remote functions. */
export const galleryApi = createServer({
	title: "Gallery API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: [sendFeedback, needsYou, artifactState, listOngoing, chooseProject, openedProject],
	services,
	auth: { browser: browserAuthentication, errors: authenticationErrors, mcp: false },
});
