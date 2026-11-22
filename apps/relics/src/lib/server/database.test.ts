import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { hash } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nextCatalogNumber } from "../allocation";
import { RelicsDatabase, Conflict, Unauthorized, Rejected, digest } from "./database";
import { encodeRelicId } from "./relic-id";

let db: RelicsDatabase;

beforeEach(() => {
	db = new RelicsDatabase(":memory:");

	db.sql.exec(
		`INSERT INTO RelicType(id,name) VALUES (1,'Shroomling');INSERT INTO RelicVariety(id,typeId,name) VALUES (1,1,'Red'),(2,1,'Orange');INSERT INTO Relic(id,name,typeId,varietyId,indexNumber) VALUES ('tag-a','Red specimen',1,1,2),('tag-b','Orange specimen',1,2,3);`,
	);
});

afterEach(() => {
	db.close();
});

const claim = (id = "tag-a") => {
	const result = db.claim({ relicId: id, name: "Test collector", relicName: "Gerald" });

	if (!result.deviceToken) {
		throw new Error("Expected a new device");
	}

	return result.deviceToken;
};

describe("private device ownership", () => {
	it("claims, shows only the current collection, releases and lets a new device claim", () => {
		const token = claim();

		expect(db.collection(token).relics.map((r) => r.id)).toEqual(["tag-a"]);
		expect(db.collection().relics).toEqual([]);
		expect(db.card("tag-a")).toMatchObject({ claimed: true, owned: false });
		expect(db.card("tag-a", token).owned).toBe(true);

		expect(db.sql.prepare("SELECT tokenHash FROM Device").get()).toEqual({
			tokenHash: digest(token),
		});

		expect(() => db.claim({ relicId: "tag-a", name: "Other", relicName: "Other friend" })).toThrow(
			Conflict,
		);

		expect(() => {
			db.release("tag-a");
		}).toThrow(Unauthorized);

		db.release("tag-a", token);
		const next = claim();

		expect(db.card("tag-a", next).owned).toBe(true);
		expect(db.collection(token).relics).toEqual([]);
	});

	it("keeps all claimed relics together on one device", () => {
		const token = claim();

		expect(
			db.claim({ relicId: "tag-b", name: "Ignored", relicName: "Pip" }, token).deviceToken,
		).toBeUndefined();

		expect(db.collection(token).relics).toHaveLength(2);

		expect(Object.keys(db.card("tag-a"))).not.toEqual(
			expect.arrayContaining([
				"ownerId",
				"collectorId",
				"email",
				"ownerEmail",
				"ownerDeviceId",
				"customDescription",
			]),
		);
	});

	it("moves a legacy owner once and clears legacy ownership when released", async () => {
		const pinHash = await hash("123456", 4);

		db.sql
			.prepare("INSERT INTO User(id,displayName,pinHash) VALUES (?,?,?)")
			.run("legacy-test", "Old Name", pinHash);

		db.sql.prepare("UPDATE Relic SET ownerId='legacy-test'").run();

		expect(() => db.claim({ relicId: "tag-a", name: "Other", relicName: "Other friend" })).toThrow(
			Conflict,
		);

		await expect(db.migrate({ name: "Old Name", pin: "0000" })).rejects.toThrow(Unauthorized);
		const { deviceToken } = await db.migrate({ name: "old name", pin: "123456" });

		expect(db.collection(deviceToken).relics).toHaveLength(2);
		await expect(db.migrate({ name: "Old Name", pin: "123456" })).rejects.toThrow(Conflict);
		db.release("tag-a", deviceToken);

		expect(db.sql.prepare("SELECT ownerId,collectorId FROM Relic WHERE id='tag-a'").get()).toEqual({
			ownerId: null,
			collectorId: null,
		});
	});

	it("adds legacy relics to an existing collection without losing new claims", async () => {
		const token = claim();

		db.sql
			.prepare("INSERT INTO User(id,displayName,pinHash) VALUES (?,?,?)")
			.run("old", "Old", await hash("1234", 4));

		db.sql.exec("UPDATE Relic SET ownerId='old' WHERE id='tag-b'");
		await db.migrate({ name: "Old", pin: "1234" }, token);
		expect(db.collection(token).relics).toHaveLength(2);
	});

	it("restores only with an unexpired, single-use email token", () => {
		const token = claim();
		const owner = db.requireCollector(token);
		const magic = db.createMagic(owner.id, "test@example.invalid");

		expect(db.recoveryCollector("test@example.invalid")).toBeUndefined();
		const restored = db.consumeMagic(magic);

		expect(db.collection(restored).relics).toHaveLength(1);
		expect(db.collection(restored).email).toBe("test@example.invalid");
		expect(() => db.consumeMagic(magic)).toThrow(Rejected);
		const expired = db.createMagic(owner.id, "test@example.invalid");

		db.sql.exec("UPDATE MagicLink SET expiresAt=0");
		expect(() => db.consumeMagic(expired)).toThrow(Rejected);
	});

	it("does not let a different collection take a verified address", () => {
		const first = claim();
		const second = claim("tag-b");
		const a = db.requireCollector(first),
			b = db.requireCollector(second);

		db.consumeMagic(db.createMagic(a.id, "test@example.invalid"));
		const collision = db.createMagic(b.id, "test@example.invalid");

		expect(() => db.consumeMagic(collision)).toThrow(Conflict);
		expect(db.collection(second).email).toBeNull();
	});

	it("gates admins with hashed sessions and expires them", () => {
		expect(db.admin()).toBeUndefined();
		const token = db.createAdmin("oidc-subject");

		expect(db.admin(token)?.subject).toBe("oidc-subject");
		db.sql.exec("UPDATE AdminSession SET expiresAt=0");
		expect(db.admin(token)).toBeUndefined();
	});

	it("limits PIN attempts persistently", () => {
		for (let i = 0; i < 6; i++) {
			db.limit("name");
		}

		expect(() => {
			db.limit("name");
		}).toThrow(Rejected);

		db.sql.exec("UPDATE RateLimit SET expiresAt=0");

		expect(() => {
			db.limit("name");
		}).not.toThrow();
	});
});

describe("catalog and tag continuity", () => {
	it("matches existing v3 physical tag encoding", () => {
		expect(encodeRelicId({ typeId: 1, varietyId: 1, index: 2 })).toBe("MMMMMMMMMWMP69LWN");
		expect(encodeRelicId({ typeId: 1, varietyId: 1, index: 3 })).toBe("MMMMMMMMMWMM69LSD");
	});

	it("allocates bounded ranges atomically and refuses overlapping or mismatched varieties", () => {
		db.administer(
			{ kind: "allocate", typeId: 1, varietyId: 1, start: 10, end: 12, lore: "Test lore" },
			"admin",
		);

		expect(db.adminData().relics).toHaveLength(5);

		expect(() => {
			db.administer(
				{ kind: "allocate", typeId: 1, varietyId: 1, start: 12, end: 15, lore: "" },
				"admin",
			);
		}).toThrow(Conflict);

		expect(db.adminData().relics).toHaveLength(5);

		expect(() => {
			db.administer(
				{ kind: "allocate", typeId: 2, varietyId: 1, start: 10, end: 12, lore: "" },
				"admin",
			);
		}).toThrow(Rejected);
	});

	it("allocates suggested numbers after legacy wildcard lore without changing old tags", () => {
		db.sql.exec("INSERT INTO AllocationRange(typeId,varietyId,lore) VALUES (1,1,'Legacy story')");
		const before = db.adminData().relics;
		const start = nextCatalogNumber({ ...db.adminData(), typeId: 1, varietyId: 1 });

		db.administer(
			{ kind: "allocate", typeId: 1, varietyId: 1, start, end: start + 4, lore: "" },
			"admin",
		);

		expect(db.adminData().relics).toEqual(expect.arrayContaining(before));
		expect(db.adminData().relics).toHaveLength(before.length + 5);

		expect(
			db.sql.prepare("SELECT startIndex,endIndex,lore FROM AllocationRange WHERE id=1").get(),
		).toEqual({ startIndex: null, endIndex: null, lore: "Legacy story" });
	});

	it("uses explicit batch stories before legacy fallback without changing old tags", () => {
		db.sql.exec("INSERT INTO AllocationRange(typeId,varietyId,lore) VALUES (1,1,'Legacy story')");
		expect(db.card("tag-a").lore).toBe("Legacy story");
		db.administer(
			{ kind: "allocate", typeId: 1, varietyId: 1, start: 3, end: 3, lore: "New batch story" },
			"admin",
		);
		expect(db.card(encodeRelicId({ typeId: 1, varietyId: 1, index: 3 })).lore).toBe(
			"New batch story",
		);
		db.administer(
			{ kind: "allocate", typeId: 1, varietyId: 1, start: 4, end: 4, lore: "" },
			"admin",
		);
		expect(db.card(encodeRelicId({ typeId: 1, varietyId: 1, index: 4 })).lore).toBe("Legacy story");
		expect(db.card("tag-a").lore).toBe("Legacy story");
	});

	it("allocates five suggested numbers for a new Snail type and variety", () => {
		db.administer({ kind: "type", name: "Snail", description: "", imageUrl: "" }, "admin");
		const typeId = db.adminData().types.find((t) => t.name === "Snail")?.id ?? 0;

		db.administer(
			{ kind: "variety", typeId, name: "Green", description: "", imageUrl: "" },
			"admin",
		);

		const varietyId = db.adminData().varieties.find((v) => v.typeId === typeId)?.id ?? 0;

		db.administer(
			{
				kind: "allocate",
				typeId,
				varietyId,
				start: nextCatalogNumber({ ...db.adminData(), typeId, varietyId }),
				end: 4,
				lore: "",
			},
			"admin",
		);

		expect(
			db
				.adminData()
				.relics.filter((r) => r.varietyId === varietyId)
				.map((r) => r.indexNumber),
		).toEqual([0, 1, 2, 3, 4]);
	});

	it("reports standalone and reserved catalog numbers and leaves a failed batch untouched", () => {
		db.sql.exec(
			"INSERT INTO AllocationRange(typeId,varietyId,startIndex,endIndex) VALUES (1,1,4,5)",
		);

		const before = db.adminData();

		expect(nextCatalogNumber({ ...before, typeId: 1, varietyId: 1 })).toBe(6);

		expect(() => {
			db.administer(
				{ kind: "allocate", typeId: 1, varietyId: 1, start: 1, end: 6, lore: "" },
				"admin",
			);
		}).toThrow("Catalog numbers 2, 4, 5 are already in use");

		expect(db.adminData()).toEqual(before);
	});

	it("reassigns and releases without changing the tag ID", () => {
		const token = claim();
		const owner = db.requireCollector(token);

		db.administer({ kind: "reassign", relicId: "tag-b", target: `collector:${owner.id}` }, "admin");
		expect(db.collection(token).relics).toHaveLength(2);
		db.administer({ kind: "reassign", relicId: "tag-a", target: "" }, "admin");
		expect(db.card("tag-a").claimed).toBe(false);
	});

	it("groups a named set and records tag writing once", () => {
		db.administer(
			{ kind: "set", name: "Test set", description: "", imageUrl: "", varietyIds: [1, 2] },
			"admin",
		);

		expect(db.collection().sets[0]?.varietyIds).toEqual([1, 2]);

		db.administer(
			{ kind: "allocate", typeId: 1, varietyId: 1, start: 10, end: 11, lore: "" },
			"admin",
		);

		for (let i = 0; i < 2; i++) {
			db.administer({ kind: "written", rangeId: 1, index: 10 }, "admin");
		}

		expect(db.adminData().ranges[0]?.writtenIndices).toEqual([10]);
	});
});

it("keeps range lore inherited and raw artwork overrides empty in admin editors", () => {
	db.sql.prepare("UPDATE RelicType SET imageUrl=? WHERE id=1").run("/uploads/type.png");

	db.administer(
		{ kind: "allocate", typeId: 1, varietyId: 1, start: 20, end: 21, lore: "First range lore" },
		"admin",
	);

	const id = encodeRelicId({ typeId: 1, varietyId: 1, index: 20 });

	expect(db.card(id).lore).toBe("First range lore");
	expect(db.adminData().relics.find((r) => r.id === id)?.imageUrl).toBeNull();
	expect(db.adminData().relics.find((r) => r.id === id)?.lore).toBeNull();
	expect(db.adminData().varieties[0]?.imageUrl).toBeNull();
	db.administer({ kind: "range", id: 1, lore: "Edited range lore" }, "admin");
	expect(db.card(id).lore).toBe("Edited range lore");
	db.administer({ kind: "range", id: 1, lore: "" }, "admin");
	expect(db.card(id).lore).toBeNull();
});

it("rejects duplicate names and missing catalog edits without reporting a service outage", () => {
	expect(() => {
		db.administer({ kind: "type", name: "Shroomling", description: "", imageUrl: "" }, "admin");
	}).toThrow(Conflict);

	expect(() => {
		db.administer({ kind: "range", id: 999, lore: "Missing" }, "admin");
	}).toThrow("no longer exists");
});

it("does not invalidate a pending email verification when another link is requested", () => {
	const token = claim();
	const owner = db.requireCollector(token);
	const pending = db.createMagic(owner.id, "new@example.invalid");

	db.createMagic(owner.id, "old@example.invalid");
	const restored = db.consumeMagic(pending);

	expect(db.collection(restored).email).toBe("new@example.invalid");
});

it("retains the complete legacy substitution alphabet across catalog sizes", () => {
	expect(encodeRelicId({ typeId: 1, varietyId: 1, index: 0 })).toBe("MMMMPVMMNQJZMMDFM");
	expect(encodeRelicId({ typeId: 5, varietyId: 2, index: 39 })).toBe("MMMMPVMPQDL3MMFQM");
	expect(encodeRelicId({ typeId: 500, varietyId: 250, index: 5000 })).toBe("PPMMKTPJKMAPPPWNJ");

	expect(encodeRelicId({ typeId: 65535, varietyId: 65535, index: 65535 })).toBe(
		"PPMPDCM555785U5L4",
	);
});

describe("a relic's little story", () => {
	it("migrates old nicknames once, retaining unnamed owners and later renames on restart", () => {
		const dir = mkdtempSync(pathModule.join(tmpdir(), "relic-story-"));
		const path = pathModule.join(dir, "legacy.db");
		let old = new RelicsDatabase(path);

		try {
			old.sql
				.exec(`INSERT INTO User(id,displayName,pinHash) VALUES ('legacy','Sam Example','unused');
        INSERT INTO RelicType(id,name) VALUES (1,'Shroomling');
        INSERT INTO RelicVariety(id,typeId,name) VALUES (1,1,'Red');
        INSERT INTO Relic(id,name,ownerId,typeId,varietyId,indexNumber,acquisitionDate) VALUES ('named','Gerald','legacy',1,1,1,1700000000000),('unnamed','Shroomling - Red #2','legacy',1,1,2,1700000000000);
        DROP TABLE RelicStory;`);

			old.close();
			old = new RelicsDatabase(path);

			expect(old.card("named")).toMatchObject({
				friendName: "Gerald",
				firstName: "Sam",
				birthday: 1700000000000,
				claimed: true,
			});

			expect(old.card("unnamed")).toMatchObject({ friendName: null, claimed: true });
			old.sql.exec("UPDATE RelicStory SET name='Pip' WHERE relicId='named'");
			old.close();
			old = new RelicsDatabase(path);
			expect(old.card("named").friendName).toBe("Pip");
			expect(old.sql.prepare("SELECT count(*) n FROM User").get()).toEqual({ n: 1 });
		} finally {
			old.close();
			rmSync(dir, { recursive: true });
		}
	});

	it("names atomically, makes only the first name public and keeps the birthday on rename", () => {
		const token = claim();
		const before = db.card("tag-a", token);

		expect(before).toMatchObject({ friendName: "Gerald", firstName: "Test", owned: true });
		expect(before.birthday).toBeTypeOf("number");

		expect(() => {
			db.nameRelic({ relicId: "tag-a", name: "Visitor", relicName: "Stolen" });
		}).toThrow(Unauthorized);

		db.nameRelic({ relicId: "tag-a", name: "Sam", relicName: "Moss" }, token);

		expect(db.card("tag-a")).toMatchObject({
			friendName: "Moss",
			firstName: "Sam",
			birthday: before.birthday,
			owned: false,
		});

		db.release("tag-a", token);

		expect(db.card("tag-a")).toMatchObject({
			friendName: null,
			firstName: null,
			birthday: null,
			claimed: false,
		});

		const next = claim();

		expect(db.card("tag-a", next).friendName).toBe("Gerald");
	});

	it("lets a migrated owner name an unnamed relic without changing ownership", async () => {
		db.sql
			.prepare("INSERT INTO User(id,displayName,pinHash) VALUES (?,?,?)")
			.run("old-unnamed", "Sam", await hash("1234", 4));

		db.sql.exec("UPDATE Relic SET ownerId='old-unnamed' WHERE id='tag-b'");
		const { deviceToken } = await db.migrate({ name: "Sam", pin: "1234" });

		expect(db.card("tag-b", deviceToken)).toMatchObject({ owned: true, friendName: null });
		db.nameRelic({ relicId: "tag-b", name: "Sam", relicName: "Pip" }, deviceToken);
		expect(db.card("tag-b", deviceToken)).toMatchObject({ owned: true, friendName: "Pip" });

		expect(db.sql.prepare("SELECT ownerId FROM Relic WHERE id='tag-b'").get()).toEqual({
			ownerId: "old-unnamed",
		});
	});
});

describe("Storybook rollback and staff edits", () => {
	it("ignores a story after an older release and replaces it on a new claim", () => {
		const token = claim();

		db.sql.exec(
			"UPDATE Relic SET collectorId=NULL,ownerId=NULL,acquisitionDate=NULL WHERE id='tag-a'",
		);

		expect(db.card("tag-a")).toMatchObject({ claimed: false, friendName: null });
		db.claim({ relicId: "tag-a", name: "Sam", relicName: "New friend" }, token);
		expect(db.card("tag-a", token)).toMatchObject({ owned: true, friendName: "New friend" });
		db.sql.exec("UPDATE Relic SET acquisitionDate=1 WHERE id='tag-a'");
		expect(db.card("tag-a", token)).toMatchObject({ owned: true, friendName: null });
		db.nameRelic({ relicId: "tag-a", name: "Sam", relicName: "A fresh story" }, token);
		expect(db.card("tag-a", token).friendName).toBe("A fresh story");
	});

	it("lets staff replace and clear a legacy custom photo", () => {
		db.sql.exec("UPDATE Relic SET customImageUrl='/uploads/old.jpg' WHERE id='tag-a'");
		expect(db.card("tag-a").imageUrl).toBe("/uploads/old.jpg");

		const edit = {
			kind: "relic",
			relicId: "tag-a",
			name: "Label",
			description: "",
			lore: "",
			imageUrl: "/uploads/new.jpg",
		} satisfies Parameters<RelicsDatabase["administer"]>[0];

		db.administer(edit, "staff");
		expect(db.card("tag-a").imageUrl).toBe("/uploads/new.jpg");
		db.administer({ ...edit, imageUrl: "" }, "staff");
		expect(db.card("tag-a").imageUrl).toBeNull();
	});

	it("clears the story when staff release a relic", () => {
		claim();
		db.administer({ kind: "reassign", relicId: "tag-a", target: "" }, "staff");
		expect(db.card("tag-a")).toMatchObject({ claimed: false, friendName: null });
	});
});

describe("ownership epochs across restarts", () => {
	it("retains a named legacy story through device migration, then clears a prior-version same-device reacquisition", async () => {
		const dir = mkdtempSync(pathModule.join(tmpdir(), "relic-epoch-"));
		const path = pathModule.join(dir, "test.db");
		let store = new RelicsDatabase(path);

		try {
			store.sql
				.prepare("INSERT INTO User(id,displayName,pinHash) VALUES ('old','Sam',?)")
				.run(await hash("1234", 4));

			store.sql.exec(
				"INSERT INTO Relic(id,name,ownerId,acquisitionDate) VALUES ('friend','Gerald','old',1700000000000);DROP TABLE RelicStory;",
			);

			store.close();
			store = new RelicsDatabase(path);
			const result = await store.migrate({ name: "Sam", pin: "1234" });
			const token = result.deviceToken;

			expect(token).toBeTypeOf("string");

			expect(store.card("friend", token)).toMatchObject({
				owned: true,
				friendName: "Gerald",
				birthday: 1700000000000,
			});

			store.close();
			store = new RelicsDatabase(path);

			expect(store.card("friend", token)).toMatchObject({
				owned: true,
				friendName: "Gerald",
				birthday: 1700000000000,
			});

			const collector = store.requireCollector(token);

			// These are the release and reclaim writes from the pre-Storybook app.
			store.sql.exec(
				"UPDATE Relic SET collectorId=NULL,ownerId=NULL,ownerEmail=NULL,ownerDeviceId=NULL,acquisitionDate=NULL WHERE id='friend'",
			);

			store.sql
				.prepare(
					"UPDATE Relic SET collectorId=?,acquisitionDate=? WHERE id=? AND ownerId IS NULL AND collectorId IS NULL",
				)
				.run(collector.id, 1800000000000, "friend");

			store.close();
			store = new RelicsDatabase(path);

			expect(store.card("friend", token)).toMatchObject({
				owned: true,
				friendName: null,
				birthday: null,
			});

			expect(store.sql.prepare("SELECT count(*) n FROM RelicStory").get()).toEqual({ n: 0 });
			store.nameRelic({ relicId: "friend", name: "Sam", relicName: "Pip" }, token);
			expect(store.card("friend", token).birthday).not.toBe(1700000000000);
		} finally {
			store.close();
			rmSync(dir, { recursive: true });
		}
	});
});
