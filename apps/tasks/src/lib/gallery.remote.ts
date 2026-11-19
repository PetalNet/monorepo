import { command, getRequestEvent, query } from "$app/server";
import { Effect, Schema } from "effect";

import { galleryApi } from "./server/gallery/api.ts";
import { Feedback } from "./server/gallery/feedback.ts";
import { SendFeedback, StateRequest } from "./server/gallery/schema.ts";

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
