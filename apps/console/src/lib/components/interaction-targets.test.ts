import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("minimum interaction targets", () => {
	it("keeps shared icon and segmented controls at least 32px tall", async () => {
		const [iconButton, segmentedControl] = await Promise.all([
			source("./IconButton.svelte"),
			source("./SegmentedControl.svelte"),
		]);

		expect(iconButton).toMatch(/width: 32px/);
		expect(iconButton).toMatch(/height: 32px/);
		expect(segmentedControl).toMatch(/min-height: 32px/);
		expect(segmentedControl).toMatch(/aria-pressed=/);
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

		expect(chip).toMatch(/min-height: 32px/);
		expect(roster).toMatch(/<IconButton/);
		expect(work).toMatch(/<IconButton/);
		expect(work).toMatch(/\.mini[^}]*min-height:32px/);
		expect(signals).toMatch(/<SegmentedControl/);
		expect(signals).toMatch(/\.primary,:global\(\.op-btn\.primary\)\{min-height:40px/);
		expect(
			(signals.match(/<IconButton/g) ?? []).length +
				(deliveryPane.match(/<IconButton/g) ?? []).length,
		).toBe(2);
		expect((cost.match(/<SegmentedControl/g) ?? []).length).toBe(2);
		expect(cost).toMatch(/<IconButton/);
		expect(terminal).toMatch(/<IconButton/);
		expect(observability).toMatch(/<SegmentedControl/);
		expect(observability).toMatch(/<IconButton/);
	});
});
