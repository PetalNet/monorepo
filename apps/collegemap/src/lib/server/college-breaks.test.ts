import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { and, eq, like, not } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRenderedCollegeBreaks } from "./college-breaks";
import { MISSING_ACADEMIC_DATE } from "./college-breaks-constants";
import { COLLEGE_NAME_MAP, importCollegeBreaks, resolveCollegeIds } from "./college-breaks-import";
import { collegeBreaks } from "./db/schema";
import * as schema from "./db/schema";

/** A lookup that fails the test loudly instead of asserting non-null and reading undefined. */
function resolvedId(resolved: Map<string, string>, school: string): string {
	const id = resolved.get(school);
	if (id === undefined) throw new Error(`test setup: ${school} did not resolve`);
	return id;
}

const WASHU_JSON_NAME = "Washington University in St. Louis (WashU)";
const ROSE_HULMAN = "Rose-Hulman Institute of Technology";
const UMKC_JSON_NAME = "University of Missouri-Kansas City (UMKC)";
const KCAI = "Kansas City Art Institute";
/**
 * Two unrelated things carry derivation "derived": the hand-bracketed spans listed below, one per
 * school at most, and the computed summer span every school gets. The label prefix is what tells
 * them apart, so the lists below stay about what they were about.
 */
const SUMMER_LABEL_PREFIX = "Summer break";
/** Spelled out once, in full: the label is the only place a reader learns the start is a guess. */
const SUMMER_LABEL =
	"Summer break (derived: ends the day before fall classes begin; opens 2026-07-01, the academic-year window boundary rather than a published date)";

/** Day arithmetic done independently of the helper the importer uses, so both cannot agree wrongly. */
function dayBefore(iso: string): string {
	const at = new Date(`${iso}T00:00:00Z`);
	at.setUTCDate(at.getUTCDate() - 1);
	return at.toISOString().slice(0, 10);
}
const DERIVED_SPANS = [
	["Cornell University", "2026-12-20", "2027-01-24"],
	["Kennesaw State University", "2026-12-15", "2027-01-10"],
	["Missouri University of Science and Technology", "2026-12-19", "2027-01-18"],
	["Otterbein University", "2026-12-11", "2027-01-13"],
	[ROSE_HULMAN, "2026-11-24", "2026-11-29"],
	["Saint Louis University", "2026-12-12", "2027-01-10"],
	[WASHU_JSON_NAME, "2026-12-17", "2027-01-18"],
] as const;

let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let databasePath: string;

beforeEach(async () => {
	databasePath = join(tmpdir(), `collegemap-breaks-${crypto.randomUUID()}.db`);
	client = createClient({ url: `file:${databasePath}` });
	await client.executeMultiple(`
		CREATE TABLE colleges (id text PRIMARY KEY NOT NULL, name text NOT NULL, kind text NOT NULL DEFAULT 'college', latitude real NOT NULL, longitude real NOT NULL, is_custom integer NOT NULL DEFAULT false);
		CREATE TABLE college_breaks (id text PRIMARY KEY NOT NULL, college_id text NOT NULL, label text NOT NULL, start_date text NOT NULL, end_date text NOT NULL, kind text NOT NULL, derivation text NOT NULL, source_url text, quote text, academic_year text NOT NULL, created_at integer NOT NULL, FOREIGN KEY (college_id) REFERENCES colleges(id));
		CREATE UNIQUE INDEX college_breaks_identity_unique ON college_breaks (college_id, label, start_date, academic_year);
	`);
	db = drizzle(client, { schema });
	await Promise.all(
		Object.values(COLLEGE_NAME_MAP).map((name, index) =>
			client.execute({
				sql: "INSERT INTO colleges (id, name, latitude, longitude, is_custom) VALUES (?, ?, 0, 0, 0)",
				args: [`college-${String(index)}`, name],
			}),
		),
	);
});

afterEach(async () => {
	client.close();
	await rm(databasePath, { force: true });
});

describe("institutional college-break import", () => {
	it("resolves every source school exactly once, including the explicit WashU name mapping", async () => {
		expect(COLLEGE_NAME_MAP[WASHU_JSON_NAME]).toBe("Washington University in St Louis");
		const resolved = await resolveCollegeIds(db);
		expect(resolved).toHaveLength(14);
		expect(resolved.get(WASHU_JSON_NAME)).toBeDefined();
	});

	it("does not match a workplace that happens to share a college's name", async () => {
		// The table holds bases and workplaces now. A second row with the same name would make the
		// exact-name join ambiguous and abort the whole import — but only if the kind is ignored.
		await client.execute({
			sql: "INSERT INTO colleges (id, name, kind, latitude, longitude, is_custom) VALUES (?, ?, 'work', 0, 0, 0)",
			args: ["work-cornell", "Cornell University"],
		});
		const resolved = await resolveCollegeIds(db);
		expect(resolved).toHaveLength(14);
		expect(resolved.get("Cornell University")).not.toBe("work-cornell");
	});

	it("imports all 243 rows idempotently", async () => {
		// 229 transcribed source rows plus one derived summer span for each of the 14 schools.
		expect(await importCollegeBreaks(db)).toBe(243);
		expect((await db.select().from(collegeBreaks)).length).toBe(243);
		expect(await importCollegeBreaks(db)).toBe(243);
		expect((await db.select().from(collegeBreaks)).length).toBe(243);
	});

	it("pins every derived span and renders each one", async () => {
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const found = await Promise.all(
			DERIVED_SPANS.map(([school]) =>
				db
					.select()
					.from(collegeBreaks)
					.where(
						and(
							eq(collegeBreaks.collegeId, resolvedId(resolved, school)),
							eq(collegeBreaks.derivation, "derived"),
							// Everything here is a hand-bracketed span. The computed summer span is derived
							// too, and is checked on its own below.
							not(like(collegeBreaks.label, `${SUMMER_LABEL_PREFIX}%`)),
						),
					),
			),
		);
		const rendered = await getRenderedCollegeBreaks(db);
		for (const [index, [school, startDate, endDate]] of DERIVED_SPANS.entries()) {
			expect(found[index]).toEqual([
				expect.objectContaining({ startDate, endDate, derivation: "derived" }),
			]);
			// Deriving a span and rendering it are one claim. A derived row that something else still
			// forces to `unknown` satisfies the pin above and then never reaches a calendar.
			expect(
				rendered.filter(
					(row) => row.collegeId === resolvedId(resolved, school) && row.startDate === startDate,
				),
			).toHaveLength(1);
		}
	});

	it("imports every transcribed Kansas City Art Institute row quoted, bracketing none of them", async () => {
		// An art school: KCAI publishes no exam period at all, and names its own "Winter Break"
		// rather than leaving it as the gap between two other entries. So every transcribed row is
		// quoted straight off the calendar and none of it is bracketed by hand. Its summer span is
		// the one derived row, computed from its own fall boundary like every other school's.
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const rows = await db
			.select()
			.from(collegeBreaks)
			.where(eq(collegeBreaks.collegeId, resolvedId(resolved, KCAI)));
		const transcribed = rows.filter((row) => !row.label.startsWith(SUMMER_LABEL_PREFIX));
		expect(rows).toHaveLength(15);
		expect(transcribed).toHaveLength(14);
		expect(transcribed.filter((row) => row.derivation !== "quoted")).toEqual([]);
		expect(rows.filter((row) => row.kind === "exam")).toEqual([]);
		expect(rows.filter((row) => row.quote === null || row.sourceUrl === null)).toEqual([]);
		expect(
			rows
				.filter((row) => row.kind === "break" || row.kind === "holiday")
				.map((row) => `${row.label} ${row.startDate}..${row.endDate}`)
				.toSorted(),
		).toEqual([
			"Degree programs mid-semester break (spring break) 2027-03-13..2027-03-21",
			"Election Day (campus closed) 2026-11-03..2026-11-03",
			"Fall Break (no classes) 2026-11-25..2026-11-29",
			"Labor Day holiday (campus closed) 2026-09-05..2026-09-07",
			"Martin Luther King Jr. Holiday (campus closed) 2027-01-18..2027-01-18",
			// Derived, not published: KCAI's fall classes begin 2026-08-24, and having no exam period
			// anywhere in its year changes nothing about where the summer window closes.
			`${SUMMER_LABEL} 2026-07-01..2026-08-23`,
			"Winter Break (campus closed) 2026-12-17..2027-01-03",
		]);
	});
});

// Rose-Hulman runs quarters, so the scraper's hunt for an event named "Thanksgiving break" found
// nothing and left the row undated and unverifiable, hiding a real six-day gap between the fall
// term ending and the winter quarter starting. The published entries bracket it exactly, so the row
// is derived like the winter breaks above and leaves UNVERIFIABLE_ROWS. The commencement below is
// the control: it has no neighbouring entries to bracket it from and stays exactly as it was.
describe("rows the source calendar never published as an event", () => {
	it("derives Rose-Hulman's Thanksgiving break from its own term boundaries", async () => {
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const collegeId = resolvedId(resolved, ROSE_HULMAN);
		const stored = await db
			.select()
			.from(collegeBreaks)
			.where(
				and(eq(collegeBreaks.collegeId, collegeId), eq(collegeBreaks.label, "Thanksgiving break")),
			);
		expect(stored).toEqual([
			expect.objectContaining({
				startDate: "2026-11-24",
				endDate: "2026-11-29",
				kind: "break",
				derivation: "derived",
			}),
		]);
		// An inferred span still has to say what it was inferred from.
		expect(stored.at(0)?.sourceUrl).toContain("rose-hulman.edu");
		expect(stored.at(0)?.quote).toContain("Fall Term Ends");

		const rendered = await getRenderedCollegeBreaks(db, collegeId);
		expect(rendered.map((row) => row.label)).toContain("Thanksgiving break");
	});

	it("leaves UMKC's undated commencement unverifiable and unrendered", async () => {
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const collegeId = resolvedId(resolved, UMKC_JSON_NAME);
		const stored = await db
			.select()
			.from(collegeBreaks)
			.where(
				and(
					eq(collegeBreaks.collegeId, collegeId),
					eq(collegeBreaks.label, "Spring 2027 commencement"),
				),
			);
		// `unknown`, not the `commencement` the classifier would otherwise give it: the row is still
		// being forced, so the mechanism is intact rather than merely unused.
		expect(stored).toEqual([
			expect.objectContaining({
				kind: "unknown",
				startDate: MISSING_ACADEMIC_DATE,
				endDate: MISSING_ACADEMIC_DATE,
				derivation: "quoted",
			}),
		]);

		const rendered = await getRenderedCollegeBreaks(db, collegeId);
		expect(rendered.length).toBeGreaterThan(0); // Positive control: an empty query is not success.
		expect(rendered.map((row) => row.label)).not.toContain("Spring 2027 commencement");
	});
});

/**
 * The derived summer spans, checked against the data rather than against a list of dates.
 *
 * Nothing below names a school's fall-start date except the deliberate pins: the expectation is
 * re-read out of the imported rows every run, so a school added tomorrow is covered the day it
 * lands and a corrected fall-start date moves the assertion with it. Kansas City Art Institute is
 * the proof rather than the promise: it arrived after this rule was written and got its span with
 * no change here.
 */
describe("derived summer break spans", () => {
	interface SummerCheck {
		school: string;
		summer: (typeof collegeBreaks.$inferSelect)[];
		fallStart: string | undefined;
	}

	async function importAndCollect(): Promise<SummerCheck[]> {
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const rows = await db.select().from(collegeBreaks);
		return [...resolved].map(([school, collegeId]) => {
			const mine = rows.filter((row) => row.collegeId === collegeId);
			return {
				school,
				summer: mine.filter((row) => row.label.startsWith(SUMMER_LABEL_PREFIX)),
				fallStart: mine
					.filter((row) => row.kind === "term_boundary" && row.startDate.startsWith("20"))
					.map((row) => row.startDate)
					.toSorted()
					.at(0),
			};
		});
	}

	it("gives every school exactly one summer span, ending the day before its own fall start", async () => {
		const checks = await importAndCollect();
		expect(checks).toHaveLength(14);
		// Positive control: without a fall-start row on every school the comparison below has nothing
		// to compare against and would pass on an empty dataset.
		expect(checks.filter((entry) => entry.fallStart === undefined).map((e) => e.school)).toEqual(
			[],
		);
		expect(
			checks
				.filter((entry) => entry.summer.length !== 1)
				.map((entry) => `${entry.school} -> ${String(entry.summer.length)} summer spans`),
		).toEqual([]);
		expect(
			checks
				.filter((entry) => entry.summer.at(0)?.endDate !== dayBefore(entry.fallStart ?? ""))
				.map(
					(entry) =>
						`${entry.school}: summer ends ${String(entry.summer.at(0)?.endDate)}, fall starts ${String(entry.fallStart)}`,
				),
		).toEqual([]);
	});

	it("pins the two extremes: Rose-Hulman ends 2026-09-02 and Missouri State ends 2026-08-16", async () => {
		const checks = await importAndCollect();
		const endOf = (school: string) =>
			checks.find((entry) => entry.school === school)?.summer.at(0)?.endDate;
		expect(endOf(ROSE_HULMAN)).toBe("2026-09-02");
		expect(endOf("Missouri State University-Springfield")).toBe("2026-08-16");
	});

	it("covers a school that publishes no exam period at all", async () => {
		// KCAI landed after this rule was written and has fewer obligation rows than anything else in
		// the set: no finals week anywhere in its year. The anchor is a term boundary, not an exam, so
		// nothing about that changes where its summer closes.
		const checks = await importAndCollect();
		const kcai = checks.find((entry) => entry.school === KCAI);
		expect(kcai?.fallStart).toBe("2026-08-24");
		expect(kcai?.summer.at(0)?.endDate).toBe("2026-08-23");
	});

	it("opens every summer span on the academic-year boundary, says so in the label, and renders", async () => {
		const checks = await importAndCollect();
		const rendered = await getRenderedCollegeBreaks(db);
		for (const entry of checks) {
			expect(entry.summer).toEqual([
				expect.objectContaining({
					label: SUMMER_LABEL,
					startDate: "2026-07-01",
					kind: "break",
					derivation: "derived",
				}),
			]);
			const row = entry.summer.at(0);
			// Provenance: the row has to point at the published boundary it was derived from.
			expect(row?.quote).toContain(String(entry.fallStart));
			expect(row?.sourceUrl).toMatch(/^https:\/\//);
			// Deriving a span and rendering it are one claim, the same way the hand-bracketed spans
			// are checked: a summer row that never reaches a calendar has fixed nothing.
			expect(rendered.filter((candidate) => candidate.id === row?.id)).toHaveLength(1);
		}
	});

	it("takes the earliest fall boundary where a school publishes two, so nobody is shown free in class", async () => {
		// Missouri Baptist starts evening classes 2026-08-24 and day classes 2026-08-26.
		const checks = await importAndCollect();
		const mbu = checks.find((entry) => entry.school === "Missouri Baptist University");
		expect(mbu?.summer.at(0)?.endDate).toBe("2026-08-23");
		expect(mbu?.summer.at(0)?.quote).toContain("evening classes");
	});
});

describe("rendered institutional breaks", () => {
	it("returns a known college's break rows while excluding every non-rendered kind", async () => {
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const cornellId = resolvedId(resolved, "Cornell University");
		await db.insert(collegeBreaks).values(
			["term_boundary", "exam", "commencement", "admin", "unknown"].map((kind, index) => ({
				collegeId: cornellId,
				label: `Hidden ${kind}`,
				startDate: `2028-01-0${String(index + 1)}`,
				endDate: `2028-01-0${String(index + 1)}`,
				kind: kind as (typeof collegeBreaks.kind.enumValues)[number],
				derivation: "quoted" as const,
				academicYear: "test",
			})),
		);

		const rows = await getRenderedCollegeBreaks(db, cornellId);
		expect(rows.length).toBeGreaterThan(0); // Positive control: an empty query is not success.
		expect(rows.every((row) => row.kind === "break" || row.kind === "holiday")).toBe(true);
		expect(rows.map((row) => row.label)).not.toContain("Hidden unknown");
	});
});

// A winter-break span that a source calendar never published gets bracketed by hand from two other
// entries, and the bracketing lands the endpoints ON those entries — telling a student the break
// starts the morning of their last exam and ends on the first day of spring class. Two rows shipped
// that way. Rather than pin those two dates (see above), assert the property they violated, against
// the whole imported dataset, so a fourteenth school transcribed the same way fails on arrival.
const OBLIGATION_KINDS = new Set<string>(["exam", "term_boundary"]);
const RENDERED_KINDS = new Set<string>(["break", "holiday"]);

interface Span {
	label: string;
	startDate: string;
	endDate: string;
}

/** Inclusive on both ends: sharing a single calendar day is the whole defect. */
function collides(left: Span, right: Span): boolean {
	return left.startDate <= right.endDate && right.startDate <= left.endDate;
}

function hasRealDates(row: Span): boolean {
	return row.startDate !== MISSING_ACADEMIC_DATE && row.endDate !== MISSING_ACADEMIC_DATE;
}

describe("rendered breaks against academic obligations", () => {
	interface SchoolRows {
		school: string;
		obligations: Span[];
		rendered: Span[];
		/** The span crossing New Year's Day — every school publishes exactly one: its winter break. */
		winter: Span[];
	}

	async function importAndGroup(): Promise<SchoolRows[]> {
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const rows = await db.select().from(collegeBreaks);
		const byCollege = new Map<string, typeof rows>();
		for (const row of rows) {
			byCollege.set(row.collegeId, [...(byCollege.get(row.collegeId) ?? []), row]);
		}
		return [...resolved].map(([school, collegeId]) => {
			const dated = (byCollege.get(collegeId) ?? []).filter(hasRealDates);
			const rendered = dated.filter((row) => RENDERED_KINDS.has(row.kind));
			return {
				school,
				obligations: dated.filter((row) => OBLIGATION_KINDS.has(row.kind)),
				rendered,
				winter: rendered.filter((row) => row.startDate.slice(0, 4) !== row.endDate.slice(0, 4)),
			};
		});
	}

	it("gives every school obligations, rendered rows and one winter span to check", async () => {
		// Without this the collision sweep below passes just as happily over an empty dataset.
		const schools = await importAndGroup();
		expect(schools).toHaveLength(14);
		expect(schools.filter((entry) => entry.obligations.length === 0)).toEqual([]);
		expect(schools.filter((entry) => entry.rendered.length === 0)).toEqual([]);
		expect(
			schools
				.filter((entry) => entry.winter.length !== 1)
				.map((entry) => `${entry.school} -> ${String(entry.winter.length)} winter spans`),
		).toEqual([]);
	});

	it("detects a collision for every school when a winter span is stretched onto its brackets", async () => {
		// Positive control for the sweep itself: a green result below has to mean "no school collides",
		// never "the comparison never found anything to compare against".
		const schools = await importAndGroup();
		const undetected = schools.filter(({ obligations, winter }) => {
			const span = winter.at(0);
			if (!span) return true;
			const ends = obligations
				.filter((row) => row.endDate < span.startDate)
				.map((row) => row.endDate);
			const starts = obligations
				.filter((row) => row.startDate > span.endDate)
				.map((row) => row.startDate);
			const lastFall = ends.toSorted().at(-1);
			const firstSpring = starts.toSorted().at(0);
			if (lastFall === undefined || firstSpring === undefined) return true;
			const stretched = { label: span.label, startDate: lastFall, endDate: firstSpring };
			return !obligations.some((row) => collides(stretched, row));
		});
		expect(undetected.map((entry) => entry.school)).toEqual([]);
	});

	it("renders no break that shares a day with one of its own school's obligations", async () => {
		const schools = await importAndGroup();
		const collisions = schools.flatMap(({ school, obligations, rendered }) =>
			rendered.flatMap((row) =>
				obligations
					.filter((obligation) => collides(row, obligation))
					.map(
						(obligation) =>
							`${school}: "${row.label}" ${row.startDate}..${row.endDate} covers "${obligation.label}" ${obligation.startDate}..${obligation.endDate}`,
					),
			),
		);
		expect(collisions).toEqual([]);
	});
});
