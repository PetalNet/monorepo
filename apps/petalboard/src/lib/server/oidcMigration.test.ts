import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

const MIGRATION = "20261101000000_oidc_login";
const appRoot = path.resolve(import.meta.dirname, "../../..");
const dir = mkdtempSync(path.join(tmpdir(), "petalboard-oidc-migration-"));
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
	it("clears password-era sessions while preserving users without an OIDC subject", () => {
		cpSync(path.join(appRoot, "prisma"), path.join(dir, "prisma"), {
			recursive: true,
			filter: (source) => !source.includes(MIGRATION) && !source.endsWith(".db"),
		});

		deploy();

		const db = new DatabaseSync(dbFile);

		db.exec(`
			INSERT INTO "User" (id, email, passwordHash, name, updatedAt)
				VALUES ('user', 'host@example.test', 'password', 'Host', 0);
			INSERT INTO "Session" (id, userId, expiresAt, createdAt)
				VALUES ('session', 'user', 0, 0);
		`);

		db.close();

		cpSync(
			path.join(appRoot, "prisma", "migrations", MIGRATION),
			path.join(dir, "prisma", "migrations", MIGRATION),
			{ recursive: true },
		);

		deploy();

		const after = new DatabaseSync(dbFile);

		expect(after.prepare(`SELECT id FROM "Session"`).all()).toStrictEqual([]);
		const users = after.prepare(`SELECT id, "oidcSubject" FROM "User"`).all();

		expect(users).toHaveLength(1);
		expect(users[0]).toMatchObject({ id: "user", oidcSubject: null });
		after.close();
	}, 60_000);
});
