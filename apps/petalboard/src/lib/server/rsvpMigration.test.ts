import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

const MIGRATION = "20261030000000_passwordless_rsvp";
const appRoot = path.resolve(import.meta.dirname, "../../..");
const dir = mkdtempSync(path.join(tmpdir(), "petalboard-migration-"));
const schema = path.join(dir, "prisma", "schema.prisma");
const dbFile = path.join(dir, "test.db");

function deploy() {
	execFileSync(
		path.join(appRoot, "node_modules/.bin/prisma"),
		["migrate", "deploy", "--schema", schema],
		{
			env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
			stdio: "ignore",
		},
	);
}

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe(`${MIGRATION} migration`, () => {
	it("normalizes emails and dedupes them per event without deleting any RSVP", () => {
		cpSync(path.join(appRoot, "prisma"), path.join(dir, "prisma"), {
			recursive: true,
			filter: (source) => !source.includes(MIGRATION) && !source.endsWith(".db"),
		});

		deploy();

		const db = new DatabaseSync(dbFile);
		const t = (iso: string) => new Date(iso).getTime();

		db.exec(`
			INSERT INTO "User" (id, email, passwordHash, name, updatedAt) VALUES ('u1', 'host@x.test', 'x', 'Host', 0);
			INSERT INTO "Event" (id, title, date, publicCode, manageToken, userId, updatedAt)
				VALUES ('e1', 'Party', 0, 'pc1', 'mt1', 'u1', 0), ('e2', 'Other', 0, 'pc2', 'mt2', 'u1', 0);
		`);

		const insert = db.prepare(
			`INSERT INTO "Rsvp" (id, name, email, pinHash, eventId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, ?)`,
		);

		insert.run("older", "Sam old", "Sam@Example.com", "h1", "e1", t("2026-10-01"));
		insert.run("newer", "Sam new", "  sam@example.com ", "h2", "e1", t("2026-10-02"));
		insert.run("nomail", "No Mail", null, "h3", "e1", t("2026-10-03"));
		insert.run("blank", "Blank", "   ", "h4", "e1", t("2026-10-03"));
		insert.run("other", "Sam elsewhere", "SAM@example.com", "h5", "e2", t("2026-09-01"));
		db.close();

		cpSync(
			path.join(appRoot, "prisma", "migrations", MIGRATION),
			path.join(dir, "prisma", "migrations", MIGRATION),
			{
				recursive: true,
			},
		);

		deploy();

		const after = new DatabaseSync(dbFile);
		const rows = Object.fromEntries(
			(
				after.prepare(`SELECT id, email FROM "Rsvp"`).all() as {
					id: string;
					email: string | null;
				}[]
			).map((r) => [r.id, r.email]),
		);

		expect(rows).toStrictEqual({
			older: null,
			newer: "sam@example.com",
			nomail: null,
			blank: null,
			other: "sam@example.com",
		});

		expect(
			after.prepare(`SELECT name FROM pragma_table_info('Rsvp') WHERE name = 'pinHash'`).all(),
		).toEqual([]);

		after.close();
	}, 60_000);
});
