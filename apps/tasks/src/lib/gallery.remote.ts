import { command, getRequestEvent, query } from "$app/server";
import { Effect, Schema } from "effect";

import { galleryApi } from "./server/gallery/api.ts";
import { Feedback } from "./server/gallery/feedback.ts";
import { choose, opened } from "./server/gallery/interest.ts";
import {
	ChooseProject,
	OpenedProject,
	SendFeedback,
	StateRequest,
} from "./server/gallery/schema.ts";

/**
 * A viewer answers a question a page asks. The viewer and the slug's rules come from the request,
 * not the page.
 */
export const sendFeedback = command(Schema.toStandardSchemaV1(SendFeedback), (input) =>
	galleryApi.run(
		Effect.flatMap(Feedback, (feedback) => feedback.send(input)),
		getRequestEvent(),
	),
);

/** The page's current revision and the viewer's own items on it; an open page refreshes this. */
export const artifactState = query(Schema.toStandardSchemaV1(StateRequest), ({ slug }) =>
	galleryApi.run(
		Effect.flatMap(Feedback, (feedback) => feedback.state(slug)),
		getRequestEvent(),
	),
);

/** Follow or hide a project, or clear the choice. */
export const chooseProject = command(
	Schema.toStandardSchemaV1(ChooseProject),
	({ project, choice }) => galleryApi.run(choose(project, choice), getRequestEvent()),
);

/**
 * The viewer arrived at a project. Called after a real navigation, never from a load, so a hovered
 * link that only preloads does not count.
 */
export const openedProject = command(Schema.toStandardSchemaV1(OpenedProject), ({ project }) =>
	galleryApi.run(opened(project), getRequestEvent()),
);
