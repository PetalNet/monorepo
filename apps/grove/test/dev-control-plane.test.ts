import { describe, expect, it } from "vitest";

import {
	devEndpointInventory,
	isGroveDevControlPlaneEnabled,
	safeReturnTo,
} from "../src/lib/server/dev/control-plane";

describe("Grove development control plane", () => {
	it("requires development mode and the explicit orb auth flag", () => {
		expect(isGroveDevControlPlaneEnabled(true, "1")).toBe(true);
		expect(isGroveDevControlPlaneEnabled(true, undefined)).toBe(false);
		expect(isGroveDevControlPlaneEnabled(true, "0")).toBe(false);
		expect(isGroveDevControlPlaneEnabled(false, "1")).toBe(false);
	});

	it.each([
		[undefined, "/"],
		["", "/"],
		["sprouts", "/"],
		["//attacker.example/path", "/"],
		["https://attacker.example/path", "/"],
		["/sprouts?filter=mine#today", "/sprouts?filter=mine#today"],
	] as const)("maps returnTo %s to %s", (candidate, expected) => {
		expect(safeReturnTo(candidate)).toBe(expected);
	});

	it("publishes portal-relative routes and characterizes OIDC redirects honestly", () => {
		const inventory = devEndpointInventory("https://grove.test");

		expect(inventory).toMatchObject({
			status: "development-only",
			endpoints: {
				login: {
					method: "GET",
					href: "https://grove.test/__dev/log-me-in/operator?returnTo=/",
					behavior: expect.stringContaining("OIDC redirects") as unknown,
				},
				logout: {
					href: "https://grove.test/__dev/log-me-out?returnTo=/",
				},
				preflight: {
					href: "https://grove.test/__dev/preflight",
				},
			},
		});
		expect(JSON.stringify(inventory)).not.toContain("localhost");
	});
});
