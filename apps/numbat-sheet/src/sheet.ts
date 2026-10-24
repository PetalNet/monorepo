export const COLUMNS = ["A", "B", "C", "D", "E", "F"] as const;
export const ROWS = Array.from({ length: 10 }, (_, i) => i + 1);

export type CellId = string & { readonly cellId: unique symbol };

export const cellId = (column: (typeof COLUMNS)[number], row: number) =>
	`${column}${row.toString()}` as CellId;

const inGrid = (ref: string): ref is CellId => /^[A-F](?:10|[1-9])$/.test(ref);

export const ERROR_CODES = [
	"#UNIT",
	"#NAME",
	"#SYNTAX",
	"#DIV/0",
	"#ERROR",
	"#CIRC_REF",
	"#REF",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type CellOutcome =
	| { ok: true; display: string; full: string }
	| { ok: false; code: ErrorCode; message: string };

export type CellResult =
	| { kind: "value"; display: string; full: string }
	| { kind: "text"; text: string }
	| { kind: "error"; code: ErrorCode; message: string }
	| { kind: "empty" };

export type Define = (id: CellId, expr: string) => CellOutcome;

/** Cell-like names, in the grid or not, outside Numbat string literals. */
function references(expr: string): string[] {
	const code = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""');

	return [...new Set(code.match(/\b[A-Z]+\d+\b/g))];
}

const fromOutcome = (outcome: CellOutcome): CellResult =>
	outcome.ok
		? { kind: "value", display: outcome.display, full: outcome.full }
		: { kind: "error", code: outcome.code, message: outcome.message };

/**
 * Input starting with `=` is a formula and may reference cells. Anything else is a literal: a
 * Numbat expression without references if Numbat accepts it, and plain text otherwise.
 *
 * Evaluates every cell after the cells it references, so `define` sees each dependency already
 * bound. Cells in a cycle, or depending on an empty, text or failed cell, never reach `define`.
 */
export function recalculate(
	inputs: ReadonlyMap<CellId, string>,
	define: Define,
): Map<CellId, CellResult> {
	const results = new Map<CellId, CellResult>();
	const path: CellId[] = [];

	const dependencyError = (ref: string): CellResult | undefined => {
		if (!inGrid(ref)) {
			return { kind: "error", code: "#REF", message: `${ref} is outside the sheet` };
		}

		const dependency = visit(ref);

		switch (dependency.kind) {
			case "value":
				return undefined;
			case "empty":
				return { kind: "error", code: "#REF", message: `${ref} is empty` };
			case "text":
				return { kind: "error", code: "#ERROR", message: `${ref} is text, not a value` };
			case "error":
				return { kind: "error", code: dependency.code, message: `${ref} has an error` };
		}
	};

	const evaluate = (id: CellId, input: string): CellResult => {
		if (!input.startsWith("=")) {
			const literal = references(input).length === 0 ? fromOutcome(define(id, input)) : undefined;

			return literal?.kind === "value" ? literal : { kind: "text", text: input };
		}

		const expr = input.slice(1).trim();

		path.push(id);

		for (const ref of references(expr)) {
			const error = dependencyError(ref);
			const blocked = results.get(id) ?? error;

			if (blocked) {
				path.pop();

				return blocked;
			}
		}

		path.pop();

		return fromOutcome(define(id, expr));
	};

	const visit = (id: CellId): CellResult => {
		const input = inputs.get(id)?.trim() ?? "";
		const start = path.indexOf(id);
		const known = results.get(id);

		if (known) {
			return known;
		}

		if (start !== -1) {
			const cycle = path.slice(start);
			const message = `circular reference: ${[...cycle, id].join(" -> ")}`;
			const error: CellResult = { kind: "error", code: "#CIRC_REF", message };

			for (const member of cycle) {
				results.set(member, error);
			}

			return error;
		}

		const result: CellResult = input === "" ? { kind: "empty" } : evaluate(id, input);

		results.set(id, result);

		return result;
	};

	for (const id of inputs.keys()) {
		visit(id);
	}

	return results;
}
