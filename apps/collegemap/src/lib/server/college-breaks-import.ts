import { inArray } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import schoolData from "../../../data/all-schools.json";
import classifyMap from "../../../data/classify-map.json";
import { MISSING_ACADEMIC_DATE } from "./college-breaks-constants";
import { collegeBreaks, colleges } from "./db/schema";
import * as schema from "./db/schema";

type Database = LibSQLDatabase<typeof schema>;
type BreakKind = (typeof collegeBreaks.kind.enumValues)[number];

interface SourceBreak {
	label: string;
	start_date: string | null;
	end_date: string | null;
	source_url: string | null;
	quote: string | null;
}

interface SourceSchool {
	name: string;
	breaks: SourceBreak[];
}

/**
 * Deliberate exact-name joins. Do not normalize names: near-collisions must fail loudly.
 *
 * @public Checked directly by tests - every right-hand side has to name a real college, and
 * one that did not once aborted the whole import.
 */
export const COLLEGE_NAME_MAP: Record<string, string> = {
	"Cornell University": "Cornell University",
	"Gustavus Adolphus College": "Gustavus Adolphus College",
	"Kennesaw State University": "Kennesaw State University",
	"Lindenwood University": "Lindenwood University",
	"Missouri Baptist University": "Missouri Baptist University",
	"Missouri State University-Springfield": "Missouri State University-Springfield",
	"Missouri University of Science and Technology": "Missouri University of Science and Technology",
	"Otterbein University": "Otterbein University",
	"Rose-Hulman Institute of Technology": "Rose-Hulman Institute of Technology",
	"Saint Louis University": "Saint Louis University",
	"Truman State University": "Truman State University",
	"University of Missouri-Kansas City (UMKC)": "University of Missouri-Kansas City",
	"Washington University in St. Louis (WashU)": "Washington University in St Louis",
};

/**
 * Winter-break rows a source calendar never published as an event: the transcriber bracketed them
 * from two neighbouring entries, so both endpoints land ON the bracketing events. Every span here
 * restates that gap exclusively — the day AFTER the last fall obligation through the day BEFORE the
 * first spring class day — and flips the row's derivation to "derived", which is what it is.
 */
const DERIVED_SPANS: Record<
	string,
	{ label: string; startDate: string; endDate: string } | undefined
> = {
	"Cornell University": {
		label: "Winter break (derived: last day of fall term through start of spring term)",
		startDate: "2026-12-20",
		endDate: "2027-01-24",
	},
	"Kennesaw State University": {
		label: "Winter break (derived: last day of fall exams through first day of spring classes)",
		startDate: "2026-12-15",
		endDate: "2027-01-10",
	},
	"Missouri University of Science and Technology": {
		label: "Winter break (fall semester close to spring classwork start)",
		startDate: "2026-12-19",
		endDate: "2027-01-18",
	},
	"Otterbein University": {
		label: "Winter break (fall exams end to spring classes begin)",
		startDate: "2026-12-11",
		endDate: "2027-01-13",
	},
	"Saint Louis University": {
		label: "Winter break (fall exams end to spring classes begin)",
		startDate: "2026-12-12",
		endDate: "2027-01-10",
	},
	"Washington University in St. Louis (WashU)": {
		label:
			"Winter break (gap between fall exams ending and spring classes starting; WashU publishes no named 'winter break' entry)",
		startDate: "2026-12-17",
		endDate: "2027-01-18",
	},
};

const UNVERIFIABLE_ROWS = new Set([
	"Rose-Hulman Institute of Technology\u0000Thanksgiving break",
	"University of Missouri-Kansas City (UMKC)\u0000Spring 2027 commencement",
]);

const schools = schoolData.schools as SourceSchool[];
const kindsByRow = classifyMap as Record<string, BreakKind>;

/** @public Exposed so tests can group imported rows by school without re-deriving the join. */
export async function resolveCollegeIds(database: Database): Promise<Map<string, string>> {
	const dbNames = Object.values(COLLEGE_NAME_MAP);
	const rows = await database
		.select({ id: colleges.id, name: colleges.name })
		.from(colleges)
		.where(inArray(colleges.name, dbNames));
	const byName = new Map<string, string[]>();
	for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row.id]);

	const resolved = new Map<string, string>();
	for (const school of schools) {
		const dbName = COLLEGE_NAME_MAP[school.name];
		const ids = dbName ? byName.get(dbName) : undefined;
		if (ids?.length !== 1) throw new Error(`Unmatched college: ${school.name}`);
		resolved.set(school.name, ids[0]);
	}
	if (resolved.size !== schools.length) throw new Error("Could not resolve every source school");
	return resolved;
}

export async function importCollegeBreaks(database: Database): Promise<number> {
	// Resolve every school before beginning the transaction, so a bad name can never partially import.
	const collegeIds = await resolveCollegeIds(database);
	const academicYear = schoolData.generated_for;
	let rowNumber = 0;
	const rows = schools.flatMap((school) => {
		// resolveCollegeIds already threw for anything unmatched, so this is belt-and-braces — but a
		// silent undefined here would write rows against no college at all.
		const collegeId = collegeIds.get(school.name);
		if (collegeId === undefined) throw new Error(`Unresolved college: ${school.name}`);

		return school.breaks.map((source) => {
			rowNumber++;
			// A school's derived span applies to exactly the one row whose label matches; its other
			// rows are quoted from the calendar as normal.
			const candidate = DERIVED_SPANS[school.name];
			const derived = candidate?.label === source.label ? candidate : undefined;
			const isUnverifiable = UNVERIFIABLE_ROWS.has(`${school.name}\u0000${source.label}`);
			return {
				collegeId,
				label: source.label,
				// Source calendars occasionally give no date at all. Keep the row and use a stable
				// non-date marker so the identity key remains re-runnable (SQLite UNIQUE treats NULLs
				// as distinct). The read path only renders real ISO dates.
				startDate: derived ? derived.startDate : (source.start_date ?? MISSING_ACADEMIC_DATE),
				endDate: derived ? derived.endDate : (source.end_date ?? MISSING_ACADEMIC_DATE),
				kind: isUnverifiable ? "unknown" : kindsByRow[String(rowNumber)],
				derivation: derived ? ("derived" as const) : ("quoted" as const),
				sourceUrl: source.source_url,
				quote: source.quote,
				academicYear,
			};
		});
	});

	await database.transaction(async (tx) => {
		await tx
			.insert(collegeBreaks)
			.values(rows)
			.onConflictDoNothing({
				target: [
					collegeBreaks.collegeId,
					collegeBreaks.label,
					collegeBreaks.startDate,
					collegeBreaks.academicYear,
				],
			});
	});

	return rows.length;
}
