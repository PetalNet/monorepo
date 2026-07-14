import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authentikUsername } from "./authentik-profile.ts";

describe("Authentik profile username", () => {
	it("prefers preferred_username", () => {
		assert.equal(
			authentikUsername({ preferred_username: "parker", email: "fallback@petalcat.dev" }),
			"parker",
		);
	});

	it("falls back to a safe email localpart and then subject", () => {
		assert.equal(authentikUsername({ email: "janet@petalcat.dev", sub: "subject-1" }), "janet");
		assert.equal(authentikUsername({ sub: "subject-1" }), "subject-1");
	});

	it("rejects unsafe identity values", () => {
		assert.equal(
			authentikUsername({
				preferred_username: "../../owner",
				email: "also/unsafe@petalcat.dev",
				sub: "contains spaces",
			}),
			"",
		);
	});
});
