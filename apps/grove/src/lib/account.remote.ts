import { BETTER_AUTH_URL } from "$app/env/private";
import { form, getRequestEvent, query } from "$app/server";
import { error, redirect } from "@sveltejs/kit";
import { Effect, Schema } from "effect";

import { GroveAuth } from "./server/auth";
import { withBrowserInvocation } from "./server/invocation";
import { runGrove } from "./server/runtime";

const accountEvent = () => {
	const event = getRequestEvent();

	if (!event.locals.actor || !event.locals.user) {
		error(401, "Sign in to manage your account");
	}

	return { event, user: event.locals.user };
};

export const currentAccount = query(() => {
	const { user } = accountEvent();

	return { name: user.name, email: user.email };
});

const AccountInput = Schema.toStandardSchemaV1(
	Schema.Struct({ name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)) }),
);

export const updateAccount = form(AccountInput, async ({ name }) => {
	const { event, user } = accountEvent();

	await runGrove(
		withBrowserInvocation(
			Effect.flatMap(GroveAuth, (auth) => auth.updateAccount(event.request.headers, name)),
		),
		event,
	);

	// Refreshes in this request must see the saved name rather than the hook's pre-update snapshot.
	event.locals.user = { ...user, name };
	await currentAccount().refresh();

	return { saved: true };
});

export const signOut = form(async () => {
	const event = getRequestEvent();

	if (!BETTER_AUTH_URL || event.request.headers.get("origin") !== new URL(BETTER_AUTH_URL).origin) {
		error(403, "Invalid request origin");
	}

	await runGrove(
		Effect.flatMap(GroveAuth, (auth) => auth.endSession(event.request.headers, "/")),
		event,
	);

	redirect(303, "/");
});
