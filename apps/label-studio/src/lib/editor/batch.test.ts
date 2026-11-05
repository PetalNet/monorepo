import { describe, expect, it } from "vitest";

import { applyMap, autoMap, parseTable, type Table } from "./batch";

const tableOf = (text: string, header: boolean): Table => {
	const parsed = parseTable(text, header);

	if (!parsed.ok) {
		throw new Error(parsed.error);
	}

	return parsed.table;
};

describe("parseTable", () => {
	it("turns plain lines into one text column", () => {
		expect(tableOf("Flour\n\nSugar\n", false)).toEqual({
			columns: [{ key: "text", label: "Text" }],
			rows: [{ text: "Flour" }, { text: "Sugar" }],
		});
	});

	it("reads CSV with a header and quoted commas", () => {
		const table = tableOf('Name,Port\n"core, rack 1",24\nedge,8', true);

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
		const table = tableOf("a\tb\nc\td", false);

		expect(table.columns.map((column) => column.label)).toEqual(["Column 1", "Column 2"]);
		expect(table.rows[1]).toEqual({ column1: "c", column2: "d" });
	});

	it("reports an unclosed quote instead of throwing, then parses once it closes", () => {
		const open = parseTable('name,location\n"Flour', true);

		expect(open.ok).toBe(false);
		expect(open.ok ? "" : open.error).toBe("Line 2 opens a quote that is never closed.");

		expect(tableOf('name,location\n"Flour",shelf', true).rows).toEqual([
			{ name: "Flour", location: "shelf" },
		]);
	});

	it("explains how to fix a stray quote", () => {
		const stray = parseTable('name,location\nFlour" mill,shelf', true);

		expect(stray.ok).toBe(false);

		expect(stray.ok ? "" : stray.error).toBe(
			"Line 2 has a stray quote. Wrap the whole value in quotes and double any quote inside it.",
		);
	});

	it("pads short rows", () => {
		expect(tableOf("x,y\n1", true).rows).toEqual([{ x: "1", y: "" }]);
	});
});

describe("mapping", () => {
	const table = tableOf("Host,IP,Rack\nnas,10.0.0.2,A\n", true);

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
