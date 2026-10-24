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
	| { kind: "value"; display: string; full: string }
	| { kind: "error"; code: ErrorCode; message: string }
	/** The expression uses a cell-like name that is not defined yet. */
	| { kind: "missing"; ref: string };

export type CellResult =
	| { kind: "value"; display: string; full: string }
	| { kind: "text"; text: string }
	| { kind: "error"; code: ErrorCode; message: string }
	| { kind: "empty" };

/** Defines cells in one Numbat scope. Numbat, not this module, finds the cells an expression uses. */
export interface Numbat {
	formula: (id: CellId, expr: string) => CellOutcome;
	/** A literal cannot use cells, so it never reports one missing. */
	literal: (id: CellId, expr: string) => CellOutcome;
}

/**
 * Input starting with `=` is a formula and may reference cells. Anything else is a literal: a
 * Numbat value if Numbat accepts it without any cells, and plain text otherwise.
 *
 * A formula that names an undefined cell defines that cell first and retries, so `numbat` sees each
 * dependency already bound. Cells in a cycle, or depending on an empty, text or failed cell, end
 * without a value.
 */
export function recalculate(
	inputs: ReadonlyMap<CellId, string>,
	numbat: Numbat,
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

	const formula = (id: CellId, expr: string): CellResult => {
		const resolved = new Set<string>();

		for (;;) {
			const outcome = numbat.formula(id, expr);

			if (outcome.kind !== "missing") {
				return outcome;
			}

			if (resolved.has(outcome.ref)) {
				return { kind: "error", code: "#ERROR", message: `${outcome.ref} did not resolve` };
			}

			resolved.add(outcome.ref);
			const error = dependencyError(outcome.ref);
			const blocked = results.get(id) ?? error;

			if (blocked) {
				return blocked;
			}
		}
	};

	const evaluate = (id: CellId, input: string): CellResult => {
		if (!input.startsWith("=")) {
			const literal = numbat.literal(id, input);

			return literal.kind === "value" ? literal : { kind: "text", text: input };
		}

		path.push(id);
		const result = formula(id, input.slice(1).trim());

		path.pop();

		return result;
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
