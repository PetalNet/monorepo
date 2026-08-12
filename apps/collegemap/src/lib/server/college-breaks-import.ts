import { and, eq, inArray } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import schoolData from "../../../data/all-schools.json";
import classifyMap from "../../../data/classify-map.json";
import { addDays, isIsoDate } from "../dates";
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
	"Kansas City Art Institute": "Kansas City Art Institute",
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
 * Breaks that exist only as the gap between two published entries. Either the transcriber bracketed
 * one by hand and landed both endpoints ON the bracketing events, or the scraper looked for an
 * event that the calendar never names and left the row undated. Every span here restates that gap
 * exclusively — the day AFTER the closing term's last obligation through the day BEFORE the next
 * term's first class day — and flips the row's derivation to "derived", which is what it is.
 *
 * `sourceUrl` and `quote` are for a row the source JSON left with none of its own: an inferred span
 * still has to say which published entries it was inferred from.
 */
const DERIVED_SPANS: Record<
	string,
	| { label: string; startDate: string; endDate: string; sourceUrl?: string; quote?: string }
	| undefined
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
	"Rose-Hulman Institute of Technology": {
		label: "Thanksgiving break",
		startDate: "2026-11-24",
		endDate: "2026-11-29",
		sourceUrl:
			"https://www.rose-hulman.edu/campus-life/student-services/registrar/2026-27_Academic_Year_Calendar.pdf",
		quote:
			"Inferred from this calendar, not quoted from it: Rose-Hulman runs quarters and names no Thanksgiving event, so the break is the gap between the day after 'November 23 Monday Final Grades Due & Fall Term Ends' and the day before 'Winter Quarter, November 30 Monday Classes Begin'.",
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

/**
 * Rows the source calendar dated `not_found` and gave no URL for, and that nothing else
 * establishes: forced to `unknown` so nothing downstream reads an undated row as a real break.
 * Membership is a claim about what could not be established, so a row leaves this set the moment
 * DERIVED_SPANS brackets it from published entries. UMKC's stays: a commencement is a single
 * ceremony date, a point event with no neighbouring entries to bracket it from.
 */
const UNVERIFIABLE_ROWS = new Set([
	"University of Missouri-Kansas City (UMKC)\u0000Spring 2027 commencement",
]);

const schools = schoolData.schools as SourceSchool[];
const kindsByRow = classifyMap as Record<string, BreakKind>;

/** A source row carrying the kind `classify-map.json` gave it, keyed by its position in the file. */
interface ClassifiedBreak extends SourceBreak {
	kind: BreakKind;
}

interface ClassifiedSchool {
	school: SourceSchool;
	rows: ClassifiedBreak[];
}

/**
 * Every source row paired with its classification, walked in file order.
 *
 * `classify-map.json` is keyed by a row's 1-based position across the whole file, so the walk order
 * is the key: numbering has to happen exactly once, before anything else looks at a row's kind.
 */
function classifySchools(): ClassifiedSchool[] {
	let rowNumber = 0;
	return schools.map((school) => ({
		school,
		rows: school.breaks.map((source) => {
			rowNumber++;
			return { ...source, kind: kindsByRow[String(rowNumber)] };
		}),
	}));
}

/** The month and day a US academic year turns over. Institutions run 1 July to 30 June. */
const ACADEMIC_YEAR_OPENS = "-07-01";

/**
 * The day the derived summer window opens.
 *
 * There is no "spring term ended" row to bracket summer against: the dataset is generated for one
 * academic year and publishes nothing before that year's fall term. Rather than invent a
 * spring-2026 end date no registrar printed, the window opens on the first day of the academic year
 * the dataset is generated for, which is the earliest day it can speak about at all. That start is
 * a coverage boundary and not an event, and the label says so out loud.
 */
function academicYearOpensOn(generatedFor: string): string {
	const year = /^\d{4}/.exec(generatedFor)?.[0];
	if (year === undefined) throw new Error(`No start year in generated_for: ${generatedFor}`);
	return `${year}${ACADEMIC_YEAR_OPENS}`;
}

function isDatedTermBoundary(
	row: ClassifiedBreak,
): row is ClassifiedBreak & { start_date: string } {
	return row.kind === "term_boundary" && isIsoDate(row.start_date);
}

/**
 * The published row a school's summer break is anchored to: the earliest dated term boundary it
 * prints, which in a dataset that begins at fall term is its first day of fall classes.
 *
 * Where a school prints two of them the earliest wins. Missouri Baptist starts evening classes on
 * 24 August and day classes on the 26th; a summer break running to the 25th would tell an evening
 * student they are free on a day they are already in class, and it would collide with a
 * term_boundary row the invariant sweep checks. The first obligation anybody at the school has is
 * the one that ends the school's summer.
 */
function fallStartRow(
	school: string,
	rows: ClassifiedBreak[],
): ClassifiedBreak & { start_date: string } {
	const anchor = rows
		.filter(isDatedTermBoundary)
		.toSorted((left, right) => left.start_date.localeCompare(right.start_date))
		.at(0);
	if (!anchor) throw new Error(`No dated term boundary to anchor a summer break: ${school}`);
	return anchor;
}

/**
 * The summer break every school has and none of them publishes.
 *
 * Unlike `DERIVED_SPANS`, which restates a gap a transcriber already bracketed by hand, this one is
 * computed per school from another of that school's own rows, so there is nothing to hand-write: a
 * school gets its summer the moment its calendar is transcribed, whether or not anyone remembers
 * this file exists. Kansas City Art Institute arrived that way and needed no entry.
 *
 * The end date is the day BEFORE fall classes begin, the exclusive-gap convention every other span
 * here follows. Note what that does and does not claim: it is the day the school's obligations
 * resume, not the day a given student goes back. Most people leave well before the first lecture,
 * for move-in, orientation, athletics or a job, and no published calendar knows when. The label
 * names the anchor for exactly that reason.
 */
function summerBreakRow(
	entry: ClassifiedSchool,
	collegeId: string,
	windowStart: string,
	academicYear: string,
) {
	const anchor = fallStartRow(entry.school.name, entry.rows);
	return {
		collegeId,
		label: `Summer break (derived: ends the day before fall classes begin; opens ${windowStart}, the academic-year window boundary rather than a published date)`,
		startDate: windowStart,
		endDate: addDays(anchor.start_date, -1),
		kind: "break" as const,
		derivation: "derived" as const,
		sourceUrl: anchor.source_url,
		quote: `Derived from this school's earliest published fall term boundary, "${anchor.label}" (${anchor.start_date}): ${anchor.quote ?? "source row published no quote"}`,
		academicYear,
	};
}

/** @public Exposed so tests can group imported rows by school without re-deriving the join. */
export async function resolveCollegeIds(database: Database): Promise<Map<string, string>> {
	const dbNames = Object.values(COLLEGE_NAME_MAP);
	// Colleges only. The table now holds bases and workplaces too, and one of those sharing a name
	// with a school would make the join ambiguous and abort an import that has nothing wrong with it.
	const rows = await database
		.select({ id: colleges.id, name: colleges.name })
		.from(colleges)
		.where(and(inArray(colleges.name, dbNames), eq(colleges.kind, "college")));
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
	const windowStart = academicYearOpensOn(academicYear);
	const rows = classifySchools().flatMap((entry) => {
		const { school } = entry;
		// resolveCollegeIds already threw for anything unmatched, so this is belt-and-braces — but a
		// silent undefined here would write rows against no college at all.
		const collegeId = collegeIds.get(school.name);
		if (collegeId === undefined) throw new Error(`Unresolved college: ${school.name}`);

		const quoted = entry.rows.map((source) => {
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
				kind: isUnverifiable ? "unknown" : source.kind,
				derivation: derived ? ("derived" as const) : ("quoted" as const),
				// A derived row states its own provenance when the source row carries none, so a later
				// reader can see which published entries the span was inferred from.
				sourceUrl: derived?.sourceUrl ?? source.source_url,
				quote: derived?.quote ?? source.quote,
				academicYear,
			};
		});

		// Appended per school rather than hand-written into DERIVED_SPANS: summer is computed from
		// one of this school's own rows, so it needs no transcription to exist.
		return [...quoted, summerBreakRow(entry, collegeId, windowStart, academicYear)];
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
