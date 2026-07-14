import assert from "node:assert/strict";
import test from "node:test";

import { authGateDecision } from "./auth-gate-policy.ts";

test("an unauthenticated app request is redirected before route loading", () => {
	assert.deepEqual(authGateDecision("/network", "?view=lines", false), {
		redirectTo: "/login?returnTo=%2Fnetwork%3Fview%3Dlines",
	});
});

test("the login page is the only unauthenticated page allowed", () => {
	assert.equal(authGateDecision("/login", "", false), "allow");
	assert.deepEqual(authGateDecision("/", "", false), { redirectTo: "/login?returnTo=%2F" });
});

test("an authenticated request reaches the app and cannot return to login", () => {
	assert.equal(authGateDecision("/network", "", true), "allow");
	assert.equal(authGateDecision("/login", "", true), "home");
});
