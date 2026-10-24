import { describe, expect, it } from "vitest";

import { type CellId, type CellOutcome, recalculate } from "./sheet.ts";

const sheet = (cells: Record<string, string>) =>
	new Map(Object.entries(cells) as [CellId, string][]);

/** Echoes each expression back as its value, rejects `rejected` cells, and records call order. */
function recorder(rejected: string[] = []) {
	const calls: string[] = [];

	const define = (id: CellId, expr: string): CellOutcome => {
		calls.push(id);

		return rejected.includes(id)
			? { ok: false, code: "#UNIT", message: `bad ${expr}` }
			: { ok: true, display: expr, full: expr };
	};

	return { calls, define };
}

const at = (results: Map<CellId, unknown>, id: string) => results.get(id as CellId);

describe("recalculate", () => {
	it("defines each cell after the cells it references, with the leading = stripped", () => {
		const { calls, define } = recorder();
		const results = recalculate(sheet({ C1: "=B1 / A1 -> mph", B1: "=A1 * 2", A1: "3 m" }), define);

		expect(calls).toEqual(["A1", "B1", "C1"]);

		expect(at(results, "C1")).toEqual({
			kind: "value",
			display: "B1 / A1 -> mph",
			full: "B1 / A1 -> mph",
		});
	});

	it("keeps a literal Numbat rejects, or one naming a cell, as text that formulas cannot use", () => {
		const { calls, define } = recorder(["A1"]);
		const results = recalculate(
			sheet({ A1: "distance", A2: "26.2 mi", A3: "see B1", A4: '="see B1"', B2: "=A1" }),
			define,
		);

		expect(at(results, "A1")).toEqual({ kind: "text", text: "distance" });
		expect(at(results, "A2")).toMatchObject({ kind: "value", display: "26.2 mi" });
		expect(at(results, "A3")).toEqual({ kind: "text", text: "see B1" });
		expect(at(results, "A4")).toMatchObject({ kind: "value", display: '"see B1"' });

		expect(at(results, "B2")).toEqual({
			kind: "error",
			code: "#ERROR",
			message: "A1 is text, not a value",
		});

		expect(calls).toEqual(["A1", "A2", "A4"]);
	});

	it("follows references inside string interpolation but not plain string text", () => {
		const { calls, define } = recorder();
		const results = recalculate(
			sheet({ A1: '="{B1}"', B1: "3 m", C1: '="{C1}"', D1: '"{B1}"', E1: '="B1"' }),
			define,
		);

		expect(calls).toEqual(["B1", "A1", "E1"]);
		expect(at(results, "C1")).toMatchObject({ code: "#CIRC_REF" });
		expect(at(results, "D1")).toEqual({ kind: "text", text: '"{B1}"' });
	});

	it("marks every cell in a cycle with the cycle path and sends none of them to Numbat", () => {
		const { calls, define } = recorder();
		const results = recalculate(sheet({ A1: "=B1", B1: "=A1 + 1", C1: "=A1", D1: "=D1" }), define);
		const cycle = {
			kind: "error",
			code: "#CIRC_REF",
			message: "circular reference: A1 -> B1 -> A1",
		};

		expect(at(results, "A1")).toEqual(cycle);
		expect(at(results, "B1")).toEqual(cycle);

		expect(at(results, "C1")).toEqual({
			kind: "error",
			code: "#CIRC_REF",
			message: "A1 has an error",
		});

		expect(at(results, "D1")).toMatchObject({ message: "circular reference: D1 -> D1" });
		expect(calls).toEqual([]);
	});

	it("names an empty, outside or failed dependency instead of evaluating the dependent", () => {
		const { calls, define } = recorder(["A1"]);
		const results = recalculate(
			sheet({ A1: "=oops", B1: "=A1 + 1", C1: "=B9 * 2", D1: "=G1 → km" }),
			define,
		);

		expect(at(results, "A1")).toEqual({ kind: "error", code: "#UNIT", message: "bad oops" });
		expect(at(results, "B1")).toEqual({ kind: "error", code: "#UNIT", message: "A1 has an error" });
		expect(at(results, "C1")).toEqual({ kind: "error", code: "#REF", message: "B9 is empty" });

		expect(at(results, "D1")).toEqual({
			kind: "error",
			code: "#REF",
			message: "G1 is outside the sheet",
		});

		expect(calls).toEqual(["A1"]);
	});
});
