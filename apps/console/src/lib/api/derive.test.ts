import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { signalSeverityLabel } from "./derive.ts";

describe("signalSeverityLabel", () => {
	it("maps every signal severity to its canonical operator grade", () => {
		assert.deepEqual(
			(["p0", "danger", "warn", "info", "debug"] as const).map(signalSeverityLabel),
			["P0", "P1", "P2", "P3", "feed only"],
		);
	});
});
