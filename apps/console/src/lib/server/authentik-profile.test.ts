import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authentikProfileUser, authentikUserFields } from "./authentik-profile.ts";

describe("Authentik profile username", () => {
	it("prefers preferred_username", () => {
		assert.equal(
			authentikProfileUser({
				preferred_username: "parker",
				email: "fallback@petalcat.dev",
			}).authentikUsername,
			"parker",
		);
	});

	it("falls back to a safe email localpart and then subject", () => {
		assert.equal(
			authentikProfileUser({ email: "janet@petalcat.dev", sub: "subject-1" }).authentikUsername,
			"janet",
		);
		assert.equal(authentikProfileUser({ sub: "subject-1" }).authentikUsername, "subject-1");
	});

	it("rejects unsafe identity values", () => {
		assert.equal(
			authentikProfileUser({
				preferred_username: "../../owner",
				email: "also/unsafe@petalcat.dev",
				sub: "contains spaces",
			}).authentikUsername,
			"",
		);
	});

	it("allows Better Auth's provider parser to retain required Authentik fields", () => {
		for (const field of Object.values(authentikUserFields)) {
			assert.equal(field.required, true);
			assert.equal(field.input, true);
		}
	});

	it("falls back to the validated username when Authentik emits an empty name", () => {
		assert.deepEqual(
			authentikProfileUser({
				preferred_username: "janet",
				email: "janet@petalcat.dev",
				sub: "subject-1",
				name: "",
				groups: ["admin"],
			}),
			{
				name: "janet",
				email: "janet@petalcat.dev",
				authentikUsername: "janet",
				authentikGroups: '["admin"]',
				authentikSubject: "subject-1",
			},
		);
	});
});
