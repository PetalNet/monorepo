import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { encodeRelicId } from "../src/lib/server/relic-id.ts";
const [beforePath, afterPath, origin] = process.argv.slice(2);

if (!beforePath || !afterPath || !origin) {
	throw new Error("Usage: node scripts/continuity.ts <legacy-backup.db> <new.db> <origin>");
}

const before = new DatabaseSync(beforePath, { readOnly: true });
const after = new DatabaseSync(afterPath, { readOnly: true });
const snapshot = (db: DatabaseSync) =>
	JSON.stringify(
		db.prepare("SELECT id,ownerId,typeId,varietyId,indexNumber FROM Relic ORDER BY id").all(),
	);

if (snapshot(before) !== snapshot(after)) {
	throw new Error("Relic IDs, owner associations or catalog coordinates changed");
}

const oldUsers = JSON.stringify(before.prepare("SELECT * FROM User ORDER BY id").all());

if (oldUsers !== JSON.stringify(after.prepare("SELECT * FROM User ORDER BY id").all())) {
	throw new Error("Legacy owner records changed");
}

for (const table of ["Collector", "Device", "LegacyMigration"]) {
	const exists = before
		.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
		.get(table);

	if (
		exists &&
		JSON.stringify(before.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()) !==
			JSON.stringify(after.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
	) {
		throw new Error(`${table} ownership or device records changed`);
	}
}

if (
	JSON.stringify(before.prepare("SELECT id,collectorId FROM Relic ORDER BY id").all()) !==
	JSON.stringify(after.prepare("SELECT id,collectorId FROM Relic ORDER BY id").all())
) {
	throw new Error("Device ownership associations changed");
}

const nicknames = before
	.prepare(
		`SELECT r.id,r.name FROM Relic r LEFT JOIN RelicType t ON t.id=r.typeId LEFT JOIN RelicVariety v ON v.id=r.varietyId WHERE (r.ownerId IS NOT NULL OR r.collectorId IS NOT NULL) AND trim(r.name)<>'' AND r.name<>COALESCE(t.name,'Relic')||' - '||COALESCE(v.name,'Original')||' #'||COALESCE(r.indexNumber,0)`,
	)
	.all();

for (const row of nicknames) {
	if (after.prepare("SELECT name FROM RelicStory WHERE relicId=?").get(row.id)?.name !== row.name) {
		throw new Error("An existing nickname was not retained");
	}
}

const rows = before.prepare("SELECT id,typeId,varietyId,indexNumber FROM Relic ORDER BY id").all();

await Promise.all(
	rows.map(async (row) => {
		if (typeof row.id !== "string") {
			throw new TypeError("Invalid ID");
		}

		if (
			typeof row.typeId === "number" &&
			typeof row.varietyId === "number" &&
			typeof row.indexNumber === "number" &&
			encodeRelicId({ typeId: row.typeId, varietyId: row.varietyId, index: row.indexNumber }) !==
				row.id
		) {
			throw new Error("Tag ID encoding changed");
		}

		const response = await fetch(`${origin}/relics/${row.id}`, { redirect: "manual" });

		if (response.status !== 200) {
			throw new Error(`Tag returned ${String(response.status)}`);
		}

		const body = await response.text();

		if (!body.includes(row.id)) {
			throw new Error("Tag page is missing its catalog ID");
		}
	}),
);

const owned = before.prepare("SELECT count(*) n FROM Relic WHERE ownerId IS NOT NULL").get();

process.stdout.write(
	`${JSON.stringify({
		tagUrlsResolved: rows.length,
		ownedRelicsPreserved: owned?.n,
		ownerRecordsPreserved: before.prepare("SELECT count(*) n FROM User").get()?.n,
		nicknamesPreserved: nicknames.length,
		deviceRecordsPreserved: before.prepare("SELECT count(*) n FROM Device").get()?.n,
		ownershipDigest: createHash("sha256").update(snapshot(after)).digest("hex"),
	})}\n`,
);

before.close();
after.close();
