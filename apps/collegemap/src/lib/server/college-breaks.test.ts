import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRenderedCollegeBreaks } from "./college-breaks";
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
