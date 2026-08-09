import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import type { User } from "better-auth/types";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AuthenticationRequired, requireAuthenticatedUser } from "../src/lib/server/authorization";

const user = {
	id: "user-1",
	name: "Grove User",
	email: "grove@example.com",
	emailVerified: true,
	createdAt: new Date(),
	updatedAt: new Date(),
} satisfies User;

const eventWith = (authenticatedUser: User | null) =>
	({
		locals: { session: null, user: authenticatedUser },
		request: new Request("https://grove.test/remote-generated-endpoint"),
		// Remote-function page metadata is deliberately unrelated to authorization.
		route: { id: "/apparently-public" },
		params: { role: "admin" },
		url: new URL("https://grove.test/apparently-public?role=admin"),
	}) as unknown as RequestEvent;

const authorize = (authenticatedUser: User | null) =>
	requireAuthenticatedUser.pipe(
		Effect.provideService(SvelteKitRequestEvent, eventWith(authenticatedUser)),
	);

describe("requireAuthenticatedUser", () => {
	it("returns the user validated into server locals", async () => {
		await expect(Effect.runPromise(authorize(user))).resolves.toBe(user);
	});

	it("rejects missing server identity regardless of route metadata", async () => {
		const error = await Effect.runPromise(Effect.flip(authorize(null)));

		expect(error).toBeInstanceOf(AuthenticationRequired);
		expect(error.message).toBe("Authentication required");
	});
});
