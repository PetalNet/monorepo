import assert from "node:assert/strict";
import test from "node:test";

import { COCKPIT_SKELETON } from "./cockpit-geometry.ts";

void test("cockpit loading geometry matches the approved surface", () => {
	assert.deepEqual(COCKPIT_SKELETON, { chips: 3, attentionRows: 3, houseTiles: 4 });
});
