import { operation, operationError } from "@petalnet/effect-api";
import { createServer, SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect } from "effect";

import {
	DeliveryControl,
	DropRequest,
	Snapshot,
	SnapshotRequest,
	SnoozeRequest,
} from "../../follow-through-schema.ts";
import {
	FollowThrough,
	FollowThroughDenied,
	FollowThroughLive,
	FollowThroughUnavailable,
	FollowThroughViewer,
} from "./service.ts";

const errors = {
	FollowThroughUnavailable: operationError(FollowThroughUnavailable, {
		status: 503,
		message: "Janet's promise ledger is unavailable. Try refreshing shortly.",
	}),
	FollowThroughDenied: operationError(FollowThroughDenied, {
		status: 403,
		message: "This account cannot control Janet's promises.",
	}),
};

export const followThroughApi = createServer({
	title: "Janet follow-through",
	version: "1.0.0",
	basePath: "/api/follow-through",
	services: FollowThroughLive,
	auth: {
		browser: Effect.gen(function* () {
			const event = yield* SvelteKitRequestEvent;

			if (!event.locals.user) return yield* new FollowThroughDenied();

			return Context.make(FollowThroughViewer, { user: event.locals.user });
		}),
		errors: { FollowThroughDenied: errors.FollowThroughDenied },
		mcp: false,
	},
	operations: [
		operation({
			name: "promises.list",
			description: "Read Janet's open promises and reminder delivery state.",
			method: "GET",
			path: "/promises",
			input: SnapshotRequest,
			output: Snapshot,
			handler: () =>
				Effect.flatMap(FollowThrough, (service) => service.execute({ action: "snapshot" })),
			errors,
		}),
		operation({
			name: "promises.delivery",
			description: "Pause or resume reminder delivery without changing the scheduler.",
			method: "POST",
			path: "/delivery",
			input: DeliveryControl,
			output: Snapshot,
			handler: ({ paused }) =>
				Effect.flatMap(FollowThrough, (service) =>
					service.execute({ action: paused ? "pause" : "resume" }),
				),
			errors,
		}),
		operation({
			name: "promises.drop",
			description: "Drop an open promise with its reason recorded.",
			method: "POST",
			path: "/promises/:id/drop",
			input: DropRequest,
			output: Snapshot,
			handler: (input) =>
				Effect.flatMap(FollowThrough, (service) => service.execute({ action: "drop", ...input })),
			errors,
		}),
		operation({
			name: "promises.snooze",
			description: "Move an open promise's due time forward.",
			method: "POST",
			path: "/promises/:id/snooze",
			input: SnoozeRequest,
			output: Snapshot,
			handler: (input) =>
				Effect.flatMap(FollowThrough, (service) => service.execute({ action: "snooze", ...input })),
			errors,
		}),
	],
});

if (import.meta.hot) import.meta.hot.dispose(() => void followThroughApi.dispose());
