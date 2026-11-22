import { building } from "$app/env";
import type { RequestEvent } from "@sveltejs/kit";
import { Context, Effect, Layer } from "effect";

import {
	RelicsDatabase,
	Rejected,
	Conflict,
	Unauthorized,
	Missing,
	StorageFailure,
} from "./database";

export class RelicsStore extends Context.Service<RelicsStore, RelicsDatabase>()("relics/Store") {}
export const services = Layer.effect(
	RelicsStore,
	Effect.acquireRelease(
		Effect.sync(
			() => new RelicsDatabase(building ? ":memory:" : (process.env.RELICS_DB ?? "data/dev.db")),
		),
		(database) =>
			Effect.sync(() => {
				database.close();
			}),
	),
);

export function attempt<A>(work: () => Promise<A> | A) {
	return Effect.tryPromise({
		try: async () => await work(),
		catch: (cause) =>
			cause instanceof Rejected ||
			cause instanceof Conflict ||
			cause instanceof Unauthorized ||
			cause instanceof Missing
				? cause
				: new StorageFailure({ cause }),
	});
}

export function setDevice(event: RequestEvent, token: string) {
	event.cookies.set("relics_device", token, {
		path: "/",
		httpOnly: true,
		secure: event.url.protocol === "https:",
		sameSite: "lax",
		maxAge: 730 * 86400,
	});
}

export const device = (event: RequestEvent) => event.cookies.get("relics_device");

export function requireAdmin(store: RelicsDatabase, event: RequestEvent) {
	const admin = store.admin(event.cookies.get("relics_admin"));

	if (!admin) {
		throw new Unauthorized({ message: "Sign in with Authentik to use admin tools." });
	}

	return admin;
}
