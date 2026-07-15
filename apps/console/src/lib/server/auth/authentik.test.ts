import { describe, expect, it } from "vitest";
import { inheritedTier, validatedGroups } from "./authentik";

describe("Authentik groups", () => {
	it("allows group names containing spaces", () => {
		expect(validatedGroups(["authentik Admins"])).toEqual(["authentik Admins"]);
		expect(inheritedTier(["authentik Admins"])).toBe("owner");
	});

	it("rejects control characters", () => {
		expect(validatedGroups(["admin\nowner"])).toEqual([]);
	});
});
