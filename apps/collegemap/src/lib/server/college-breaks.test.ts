import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
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

	it("imports all 229 source rows idempotently", async () => {
		expect(await importCollegeBreaks(db)).toBe(229);
		expect((await db.select().from(collegeBreaks)).length).toBe(229);
		expect(await importCollegeBreaks(db)).toBe(229);
		expect((await db.select().from(collegeBreaks)).length).toBe(229);
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

	it("imports Kansas City Art Institute wholly quoted, with nothing derived", async () => {
		// An art school: KCAI publishes no exam period at all, and names its own "Winter Break"
		// rather than leaving it as the gap between two other entries. So every row is quoted
		// straight off the calendar and none of it is bracketed by hand.
		await importCollegeBreaks(db);
		const resolved = await resolveCollegeIds(db);
		const rows = await db
			.select()
			.from(collegeBreaks)
			.where(eq(collegeBreaks.collegeId, resolvedId(resolved, "Kansas City Art Institute")));
		expect(rows).toHaveLength(14);
		expect(rows.filter((row) => row.derivation !== "quoted")).toEqual([]);
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
