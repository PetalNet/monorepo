import { readFileSync } from "node:fs";

import type { Evidence, EvidenceRow } from "./evidence.ts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("open evidence must contain objects");
	}

	return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((item: unknown): item is string => typeof item === "string")
	) {
		throw new TypeError("open evidence must contain string lists");
	}

	return value;
}

/** Validates the puller's local artifact; malformed data must not silently use the table. */
export function normalizeOpenEvidence(raw: unknown): Evidence {
	const input = record(raw);

	if (!Array.isArray(input["rows"])) {
		throw new TypeError("open evidence has no rows array");
	}

	const rows = input["rows"].map((value: unknown): EvidenceRow => {
		const row = record(value);
		const {
			model,
			effort,
			signal,
			value: score,
			src,
			kind,
			asof,
			url,
			reporter,
			halfLifeDays,
		} = row;

		if (
			typeof model !== "string" ||
			!model ||
			typeof effort !== "string" ||
			!["low", "medium", "high", "xhigh", "max", "unspecified"].includes(effort) ||
			typeof signal !== "string" ||
			!signal ||
			typeof src !== "string" ||
			!src ||
			typeof score !== "number" ||
			!Number.isFinite(score) ||
			(kind !== "measured" && kind !== "vendor") ||
			typeof asof !== "string" ||
			!Number.isFinite(Date.parse(asof)) ||
			typeof url !== "string" ||
			!URL.canParse(url) ||
			new URL(url).protocol !== "https:" ||
			typeof reporter !== "string" ||
			!reporter ||
			typeof halfLifeDays !== "number" ||
			![90, 180, 365].includes(halfLifeDays)
		) {
			throw new TypeError("invalid open evidence row");
		}

		return { model, effort, signal, value: score, src, kind, asof, url, reporter, halfLifeDays };
	});

	return { rows, unmapped: strings(input["unmapped"]), notes: strings(input["notes"]) };
}

export function readOpenEvidence(file: string): Evidence {
	try {
		return normalizeOpenEvidence(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { rows: [], unmapped: [], notes: ["Open evidence absent; run route pull-evidence"] };
		}

		throw error;
	}
}
