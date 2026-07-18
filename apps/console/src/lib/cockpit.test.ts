import { describe, expect, it } from "vitest";

import { COCKPIT_SKELETON } from "./cockpit-geometry.ts";

describe("cockpit geometry", () => {
	it("matches the approved loading surface", () => {
		expect(COCKPIT_SKELETON).toEqual({ chips: 3, attentionRows: 3, houseTiles: 4 });
	});
});
