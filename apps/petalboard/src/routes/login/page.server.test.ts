import { describe, expect, it } from "vitest";

import * as login from "./+page.server";

describe("login", () => {
	it("has no POST action that can create a session", () => {
		expect("actions" in login).toBe(false);
	});
});
