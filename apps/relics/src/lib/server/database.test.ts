import { hash } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
	const result = db.claim({ relicId: id, name: "Test collector" });

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

		expect(() => db.claim({ relicId: "tag-a", name: "Other" })).toThrow(Conflict);

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

		expect(db.claim({ relicId: "tag-b", name: "Ignored" }, token).deviceToken).toBeUndefined();
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
		expect(() => db.claim({ relicId: "tag-a", name: "Other" })).toThrow(Conflict);
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

		expect(db.adminData().ranges[0]?.writtenIndices).toBe("[10]");
	});
});
