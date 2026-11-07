import { icons } from "lucide";
import { describe, expect, it } from "vitest";

import { kebab, loadIcons, pascal, searchIcons } from "./icons";

describe("icon names", () => {
	it("converts Lucide export names to icon names", () => {
		expect(kebab("TriangleAlert")).toBe("triangle-alert");
		expect(kebab("AArrowDown")).toBe("a-arrow-down");
		expect(kebab("Trash2")).toBe("trash-2");
	});

	it("round-trips every Lucide name to the same drawing", () => {
		const table = icons as Record<string, unknown>;
		const broken = Object.keys(table).filter((name) => table[pascal(kebab(name))] !== table[name]);

		expect(broken).toEqual([]);
	});

	it("loads every Lucide icon once and finds them by name", async () => {
		const entries = await loadIcons();
		const nodes = new Set(entries.map((entry) => entry.node));

		expect(nodes.size).toBe(entries.length);
		expect(entries.length).toBeGreaterThan(1000);
		expect(searchIcons(entries, "triangle-al")[0].name).toBe("triangle-alert");
		expect(searchIcons(entries, "wifi")[0].name).toBe("wifi");
		expect(searchIcons(entries, "").map((entry) => entry.name)).toContain("tag");
	});
});
