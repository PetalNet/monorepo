import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { describe, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("minimum interaction targets", () => {
	it("keeps shared icon and segmented controls at least 32px tall", async () => {
		const [iconButton, segmentedControl] = await Promise.all([
			source("./IconButton.svelte"),
			source("./SegmentedControl.svelte"),
		]);

		assert.match(iconButton, /width: 32px/);
		assert.match(iconButton, /height: 32px/);
		assert.match(segmentedControl, /min-height: 32px/);
		assert.match(segmentedControl, /aria-pressed=/);
	});

	it("migrates every audited compact shared control", async () => {
		const [chip, roster, work, signals, deliveryPane, cost, terminal, observability] =
			await Promise.all([
				source("./ApplyModeChip.svelte"),
				source("./RosterRow.svelte"),
				source("../../routes/work/+page.svelte"),
				source("../../routes/signals/+page.svelte"),
				source("../../routes/signals/DeliveryPane.svelte"),
				source("../../routes/cost/+page.svelte"),
				source("../../routes/terminal/+page.svelte"),
				source("../../routes/observability/+page.svelte"),
			]);

		assert.match(chip, /min-height: 32px/);
		assert.match(roster, /<IconButton/);
		assert.match(work, /<IconButton/);
		assert.match(work, /\.mini[^}]*min-height:32px/);
		assert.match(signals, /<SegmentedControl/);
		assert.match(signals, /\.primary,:global\(\.op-btn\.primary\)\{min-height:40px/);
		assert.equal(
			(signals.match(/<IconButton/g) ?? []).length +
				(deliveryPane.match(/<IconButton/g) ?? []).length,
			2,
		);
		assert.equal((cost.match(/<SegmentedControl/g) ?? []).length, 2);
		assert.match(cost, /<IconButton/);
		assert.match(terminal, /<IconButton/);
		assert.match(observability, /<SegmentedControl/);
		assert.match(observability, /<IconButton/);
	});
});
