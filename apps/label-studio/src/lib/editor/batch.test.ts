import { describe, expect, it } from "vitest";

import { applyMap, autoMap, parseTable } from "./batch";

describe("parseTable", () => {
	it("turns plain lines into one text column", () => {
		expect(parseTable("Flour\n\nSugar\n", false)).toEqual({
			columns: [{ key: "text", label: "Text" }],
			rows: [{ text: "Flour" }, { text: "Sugar" }],
		});
	});

	it("reads CSV with a header and quoted commas", () => {
		const table = parseTable('Name,Port\n"core, rack 1",24\nedge,8', true);

		expect(table.columns).toEqual([
			{ key: "name", label: "Name" },
			{ key: "port", label: "Port" },
		]);

		expect(table.rows).toEqual([
			{ name: "core, rack 1", port: "24" },
			{ name: "edge", port: "8" },
		]);
	});

	it("reads tab-separated rows pasted from a spreadsheet without a header", () => {
		const table = parseTable("a\tb\nc\td", false);

		expect(table.columns.map((column) => column.label)).toEqual(["Column 1", "Column 2"]);
		expect(table.rows[1]).toEqual({ column1: "c", column2: "d" });
	});

	it("pads short rows", () => {
		expect(parseTable("x,y\n1", true).rows).toEqual([{ x: "1", y: "" }]);
	});
});

describe("mapping", () => {
	const table = parseTable("Host,IP,Rack\nnas,10.0.0.2,A\n", true);

	it("matches variables by name first, then in order", () => {
		expect(autoMap(table.columns, ["ip", "title"])).toEqual({ ip: "ip", title: "host" });
	});

	it("leaves a variable unmapped when the columns run out", () => {
		expect(autoMap(table.columns, ["a", "b", "c", "d"]).d).toBeNull();
	});

	it("builds one vars object per row with only mapped keys", () => {
		expect(applyMap(table, { name: "host", note: null })).toEqual([{ name: "nas" }]);
	});
});
