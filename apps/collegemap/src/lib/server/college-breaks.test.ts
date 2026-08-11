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
const DERIVED_SPANS = [
	["Cornell University", "2026-12-20", "2027-01-24"],
	["Kennesaw State University", "2026-12-15", "2027-01-10"],
	["Missouri University of Science and Technology", "2026-12-19", "2027-01-18"],
	["Otterbein University", "2026-12-11", "2027-01-13"],
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
		CREATE TABLE colleges (id text PRIMARY KEY NOT NULL, name text NOT NULL, latitude real NOT NULL, longitude real NOT NULL, is_custom integer NOT NULL DEFAULT false);
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
		expect(resolved).toHaveLength(13);
		expect(resolved.get(WASHU_JSON_NAME)).toBeDefined();
	});

	it("imports all 215 source rows idempotently", async () => {
		expect(await importCollegeBreaks(db)).toBe(215);
		expect((await db.select().from(collegeBreaks)).length).toBe(215);
		expect(await importCollegeBreaks(db)).toBe(215);
		expect((await db.select().from(collegeBreaks)).length).toBe(215);
	});

	it("pins all corrected and derived winter-break spans", async () => {
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
		for (const [index, [, startDate, endDate]] of DERIVED_SPANS.entries()) {
			expect(found[index]).toEqual([
				expect.objectContaining({ startDate, endDate, derivation: "derived" }),
			]);
		}
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
		expect(schools).toHaveLength(13);
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
