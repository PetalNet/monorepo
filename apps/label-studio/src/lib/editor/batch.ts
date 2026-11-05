import type { Vars } from "$lib/doc";
import { parse } from "csv-parse/browser/esm/sync";

/** Rows of cells with named columns, from pasted text, a CSV file or a lab source. */
export interface Table {
	columns: { key: string; label: string }[];
	rows: Vars[];
}

/** A parsed table, or why the text is not one yet (an unclosed quote while typing, say). */
export type Parsed = { ok: true; table: Table } | { ok: false; error: string };

/** Which table column fills each template variable; null leaves the field default. */
export type ColumnMap = Record<string, string | null>;

const normalise = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

function csvErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return "CSV could not be read.";
	}

	const code = "code" in error && typeof error.code === "string" ? error.code : "";
	const line = "lines" in error && typeof error.lines === "number" ? error.lines : null;
	const prefix = line === null ? "" : `Line ${String(line)} `;

	if (code === "CSV_QUOTE_NOT_CLOSED") {
		return `${prefix}opens a quote that is never closed.`;
	}

	if (code.includes("QUOTE")) {
		return `${prefix}has a stray quote. Wrap the whole value in quotes and double any quote inside it.`;
	}

	return `${prefix}could not be read as CSV.`;
}

/**
 * Pasted text becomes a table. With a delimiter on the first line it is CSV (or TSV from a
 * spreadsheet) and `header` says whether the first row names the columns; otherwise every non-empty
 * line is one label with a single "text" column.
 */
export function parseTable(text: string, header: boolean): Parsed {
	const trimmed = text.replace(/\s+$/, "");

	if (trimmed === "") {
		return { ok: true, table: { columns: [], rows: [] } };
	}

	const firstLine = trimmed.split("\n", 1)[0];
	const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(",") ? "," : null;

	if (delimiter === null) {
		const lines = trimmed.split("\n").map((line) => line.trim());
		const body = header ? lines.slice(1) : lines;

		return {
			ok: true,
			table: {
				columns: [{ key: "text", label: header ? lines[0] : "Text" }],
				rows: body.filter((line) => line !== "").map((line) => ({ text: line })),
			},
		};
	}

	let records: string[][];

	try {
		records = parse(trimmed, {
			delimiter,
			relax_column_count: true,
			skip_empty_lines: true,
			trim: true,
		});
	} catch (error) {
		return { ok: false, error: csvErrorMessage(error) };
	}

	const width = Math.max(0, ...records.map((record) => record.length));
	const names = header ? (records[0] ?? []) : [];
	const used = new Set<string>();
	const columns = Array.from({ length: width }, (_, index) => {
		const label = names[index]?.trim() || `Column ${String(index + 1)}`;
		let key = normalise(label) || `col${String(index + 1)}`;

		while (used.has(key)) {
			key += "_";
		}

		used.add(key);

		return { key, label };
	});
	const rows = (header ? records.slice(1) : records).map((record) =>
		Object.fromEntries(columns.map((column, index) => [column.key, record[index] ?? ""])),
	);

	return { ok: true, table: { columns, rows } };
}

/** Match each variable to the column of the same name, else to the columns in order. */
export function autoMap(columns: Table["columns"], keys: readonly string[]): ColumnMap {
	const byName = new Map(
		columns.flatMap((column) => [
			[normalise(column.key), column.key],
			[normalise(column.label), column.key],
		]),
	);
	const taken = new Set<string>();
	const map: ColumnMap = {};

	for (const key of keys) {
		const match = byName.get(normalise(key));

		if (match !== undefined && !taken.has(match)) {
			map[key] = match;
			taken.add(match);
		}
	}

	const free = columns.filter((column) => !taken.has(column.key));

	for (const key of keys) {
		if (!(key in map)) {
			const next = free.shift();

			map[key] = next ? next.key : null;
		}
	}

	return map;
}

/** One `Vars` per row, holding only the mapped variables. */
export function applyMap(table: Table, map: ColumnMap): Vars[] {
	return table.rows.map((row) =>
		Object.fromEntries(
			Object.entries(map).flatMap(([key, column]) =>
				column === null ? [] : [[key, row[column] ?? ""]],
			),
		),
	);
}
