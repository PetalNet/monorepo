import { describe, expect, it } from "vitest";

import { type CellId, type CellOutcome, type Numbat, recalculate } from "./sheet.ts";

const sheet = (cells: Record<string, string>) =>
	new Map(Object.entries(cells) as [CellId, string][]);

/**
 * Stands in for Numbat: echoes each expression back as its value, reports the first undefined
 * cell-like name as missing, rejects `rejected` cells, and records the order cells end in.
 */
function recorder(rejected: string[] = []) {
	const calls: string[] = [];
	const bound = new Set<string>();

	const define = (id: CellId, expr: string, literal: boolean): CellOutcome => {
		const refs = expr.match(/\b[A-Z]+\d+\b/g) ?? [];
		const missing = refs.find((ref) => !bound.has(ref));

		if (missing && !literal) {
			return { kind: "missing", ref: missing };
		}

		calls.push(id);

		if (rejected.includes(id) || missing) {
			return { kind: "error", code: "#UNIT", message: `bad ${expr}` };
		}

		bound.add(id);

		return { kind: "value", display: expr, full: expr };
	};

	const numbat: Numbat = {
		formula: (id, expr) => define(id, expr, false),
		literal: (id, expr) => define(id, expr, true),
	};

	return { calls, numbat };
}

const at = (results: Map<CellId, unknown>, id: string) => results.get(id as CellId);

describe("recalculate", () => {
	it("defines each cell after the cells it references, with the leading = stripped", () => {
		const { calls, numbat } = recorder();
		const results = recalculate(sheet({ C1: "=B1 / A1 -> mph", B1: "=A1 * 2", A1: "3 m" }), numbat);

		expect(calls).toEqual(["A1", "B1", "C1"]);

		expect(at(results, "C1")).toEqual({
			kind: "value",
			display: "B1 / A1 -> mph",
			full: "B1 / A1 -> mph",
		});
	});

	it("keeps a literal Numbat rejects, or one naming a cell, as text that formulas cannot use", () => {
		const { calls, numbat } = recorder(["A1"]);
		const results = recalculate(
			sheet({ A1: "distance", A2: "26.2 mi", A3: "see B1", B2: "=A1" }),
			numbat,
		);

		expect(at(results, "A1")).toEqual({ kind: "text", text: "distance" });
		expect(at(results, "A2")).toMatchObject({ kind: "value", display: "26.2 mi" });
		expect(at(results, "A3")).toEqual({ kind: "text", text: "see B1" });

		expect(at(results, "B2")).toEqual({
			kind: "error",
			code: "#ERROR",
			message: "A1 is text, not a value",
		});

		expect(calls).toEqual(["A1", "A2", "A3"]);
	});

	it("marks every cell in a cycle with the cycle path and sends none of them to Numbat", () => {
		const { calls, numbat } = recorder();
		const results = recalculate(sheet({ A1: "=B1", B1: "=A1 + 1", C1: "=A1", D1: "=D1" }), numbat);
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
		const { calls, numbat } = recorder(["A1"]);
		const results = recalculate(
			sheet({ A1: "=oops", B1: "=A1 + 1", C1: "=B9 * 2", D1: "=G1 → km" }),
			numbat,
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
