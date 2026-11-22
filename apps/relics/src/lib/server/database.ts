import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import pathModule from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { compare } from "bcryptjs";
import { Data, Schema } from "effect";

import type { Claim, Collection, RelicCard } from "../schema";
import { Variety, type AdminCommand } from "../schema";
import legacySchema from "./legacy-schema.sql?raw";
import { encodeRelicId } from "./relic-id";

export class Rejected extends Data.TaggedError("Rejected")<{ message: string }> {}
export class Conflict extends Data.TaggedError("Conflict")<{ message: string }> {}
export class Unauthorized extends Data.TaggedError("Unauthorized")<{ message: string }> {}
export class Missing extends Data.TaggedError("Missing")<{ message: string }> {}
export class StorageFailure extends Data.TaggedError("StorageFailure")<{ cause: unknown }> {}
export const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
const nullableText = Schema.NullOr(Schema.String);
const ownerSchema = Schema.Struct({ id: Schema.String, name: Schema.String, email: nullableText });
const legacyUser = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	pinHash: Schema.String,
});
const countSchema = Schema.Struct({ n: Schema.Finite });
const rawCard = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	typeId: Schema.NullOr(Schema.Finite),
	varietyId: Schema.NullOr(Schema.Finite),
	indexNumber: Schema.NullOr(Schema.Finite),
	typeName: Schema.String,
	varietyName: Schema.String,
	description: nullableText,
	lore: nullableText,
	imageUrl: nullableText,
	friendName: nullableText,
	firstName: nullableText,
	birthday: Schema.NullOr(Schema.Finite),
	ownerId: nullableText,
	collectorId: nullableText,
});
const storyOwnerKey =
	"COALESCE('legacy:'||r.ownerId,'collector:'||r.collectorId)||':'||COALESCE(r.acquisitionDate,'')";
const cardSql = `SELECT r.id,r.name,r.typeId,r.varietyId,r.indexNumber,COALESCE(t.name,'Relic') typeName,COALESCE(v.name,'Original') varietyName,r.description,COALESCE(r.lore,(SELECT a.lore FROM AllocationRange a WHERE a.typeId=r.typeId AND a.varietyId=r.varietyId AND (a.startIndex IS NULL OR a.startIndex<=r.indexNumber) AND (a.endIndex IS NULL OR a.endIndex>=r.indexNumber) LIMIT 1)) lore,COALESCE(r.customImageUrl,r.imageUrl,v.imageUrl,t.imageUrl) imageUrl,s.name friendName,COALESCE(s.firstName,c.name,u.displayName) firstName,s.birthday,r.ownerId,r.collectorId FROM Relic r LEFT JOIN RelicType t ON t.id=r.typeId LEFT JOIN RelicVariety v ON v.id=r.varietyId LEFT JOIN RelicStory s ON s.relicId=r.id AND s.ownerKey=${storyOwnerKey} LEFT JOIN Collector c ON c.id=r.collectorId LEFT JOIN User u ON u.id=r.ownerId`;

export class RelicsDatabase {
	readonly sql: DatabaseSync;
	constructor(path: string) {
		if (path !== ":memory:") {
			mkdirSync(pathModule.dirname(path), { recursive: true });
		}

		this.sql = new DatabaseSync(path);
		this.sql.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

		this.transaction(() => {
			this.sql.exec(legacySchema);

			this.sql.exec(
				"CREATE TABLE IF NOT EXISTS Collector(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE)",
			);

			const columns = this.sql.prepare("PRAGMA table_info(Relic)").all();

			if (!columns.some((x) => x.name === "collectorId")) {
				this.sql.exec("ALTER TABLE Relic ADD COLUMN collectorId TEXT REFERENCES Collector(id)");
			}

			this.sql
				.exec(`CREATE TABLE IF NOT EXISTS Collector(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS Device(tokenHash TEXT PRIMARY KEY,collectorId TEXT NOT NULL REFERENCES Collector(id),expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS LegacyMigration(userId TEXT PRIMARY KEY REFERENCES User(id),collectorId TEXT NOT NULL REFERENCES Collector(id));
    CREATE TABLE IF NOT EXISTS MagicLink(tokenHash TEXT PRIMARY KEY,collectorId TEXT NOT NULL REFERENCES Collector(id),email TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS AdminSession(tokenHash TEXT PRIMARY KEY,subject TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS RateLimit(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS AdminAudit(id INTEGER PRIMARY KEY,subject TEXT NOT NULL,action TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS Relic_collectorId ON Relic(collectorId);`);

			if (!this.sql.prepare("SELECT 1 FROM sqlite_master WHERE name='RelicStory'").get()) {
				this.sql
					.exec(`CREATE TABLE RelicStory(relicId TEXT PRIMARY KEY REFERENCES Relic(id),name TEXT NOT NULL,firstName TEXT NOT NULL,birthday INTEGER,ownerKey TEXT NOT NULL);
        INSERT INTO RelicStory SELECT r.id,r.name,COALESCE(c.name,u.displayName,''),CASE WHEN typeof(r.acquisitionDate)='integer' THEN r.acquisitionDate ELSE CAST(strftime('%s',r.acquisitionDate) AS INTEGER)*1000 END,${storyOwnerKey}
        FROM Relic r LEFT JOIN RelicType t ON t.id=r.typeId LEFT JOIN RelicVariety v ON v.id=r.varietyId LEFT JOIN Collector c ON c.id=r.collectorId LEFT JOIN User u ON u.id=r.ownerId
        WHERE (r.ownerId IS NOT NULL OR r.collectorId IS NOT NULL) AND trim(r.name)<>'' AND r.name<>COALESCE(t.name,'Relic')||' - '||COALESCE(v.name,'Original')||' #'||COALESCE(r.indexNumber,0);`);
			}

			this.sql.exec(
				`DELETE FROM RelicStory WHERE NOT EXISTS (SELECT 1 FROM Relic r WHERE r.id=RelicStory.relicId AND RelicStory.ownerKey=${storyOwnerKey})`,
			);
		});
	}
	close() {
		this.sql.close();
	}
	transaction<A>(work: () => A): A {
		this.sql.exec("BEGIN IMMEDIATE");

		try {
			const value = work();

			this.sql.exec("COMMIT");

			return value;
		} catch (error) {
			this.sql.exec("ROLLBACK");

			throw error;
		}
	}
	one<A>(
		schema: Schema.ConstraintDecoder<A>,
		query: string,
		...params: SQLInputValue[]
	): A | undefined {
		const value = this.sql.prepare(query).get(...params);

		return value === undefined ? undefined : Schema.decodeSync(schema)(value);
	}
	many<A>(schema: Schema.ConstraintDecoder<A>, query: string, ...params: SQLInputValue[]): A[] {
		return [...Schema.decodeSync(Schema.Array(schema))(this.sql.prepare(query).all(...params))];
	}
	collector(token: string | undefined) {
		if (!token) {
			return undefined;
		}

		return this.one(
			ownerSchema,
			"SELECT c.* FROM Collector c JOIN Device d ON d.collectorId=c.id WHERE d.tokenHash=? AND d.expiresAt>?",
			digest(token),
			Date.now(),
		);
	}
	createDevice(collectorId: string) {
		const token = newToken();

		this.sql
			.prepare("INSERT INTO Device VALUES (?,?,?)")
			.run(digest(token), collectorId, Date.now() + 730 * 86400000);

		return token;
	}
	requireCollector(token: string | undefined) {
		const collector = this.collector(token);

		if (!collector) {
			throw new Unauthorized({ message: "Open your collection on this device first." });
		}

		return collector;
	}
	limit(key: string, max = 6, windowMs = 3600000) {
		this.sql.prepare("DELETE FROM RateLimit WHERE expiresAt<?").run(Date.now());

		const row = this.one(
			countSchema,
			`INSERT INTO RateLimit VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts n`,
			digest(key),
			Date.now() + windowMs,
		);

		if (row && row.n > max) {
			throw new Rejected({ message: "Too many attempts. Please try again in an hour." });
		}
	}
	card(id: string, token?: string): RelicCard {
		const row = this.one(rawCard, `${cardSql} WHERE r.id=?`, id);

		if (!row) {
			throw new Missing({
				message: "This tag is not in the catalog. Check its URL or ask an admin.",
			});
		}

		return this.publicCard(row, this.collector(token)?.id);
	}
	private publicCard(row: typeof rawCard.Type, collectorId?: string): RelicCard {
		const { ownerId, collectorId: owner, ...publicData } = row;
		const firstName = publicData.firstName?.trim().split(/\s+/)[0];

		return {
			...publicData,
			firstName: firstName === "" ? null : (firstName ?? null),
			claimed: ownerId !== null || owner !== null,
			owned: Boolean(collectorId) && owner === collectorId,
		};
	}
	collection(token?: string): typeof Collection.Type {
		const collector = this.collector(token);
		const relics = collector
			? this.many(
					rawCard,
					`${cardSql} WHERE r.collectorId=? ORDER BY r.typeId,r.varietyId,r.indexNumber`,
					collector.id,
				).map((row) => this.publicCard(row, collector.id))
			: [];
		const varieties = this.many(
			Variety,
			`SELECT v.id,v.typeId,v.name,t.name typeName,v.description,COALESCE(v.imageUrl,t.imageUrl) imageUrl FROM RelicVariety v JOIN RelicType t ON t.id=v.typeId ORDER BY t.id,v.id`,
		);
		const sets = this.many(
			Schema.Struct({
				id: Schema.Finite,
				name: Schema.String,
				description: nullableText,
				imageUrl: nullableText,
			}),
			"SELECT id,name,description,imageUrl FROM RelicSet ORDER BY id",
		).map((s) => ({
			...s,
			varietyIds: this.many(
				Schema.Struct({ id: Schema.Finite }),
				`SELECT DISTINCT v.id FROM SetMember m JOIN RelicVariety v ON v.typeId=m.typeId AND (m.varietyId IS NULL OR m.varietyId=v.id) WHERE m.setId=?`,
				s.id,
			).map((x) => x.id),
		}));

		return {
			name: collector?.name ?? null,
			email: collector?.email ?? null,
			relics,
			varieties,
			sets,
		};
	}
	claim(input: typeof Claim.Type, token?: string) {
		return this.transaction(() => {
			const card = this.card(input.relicId, token);

			if (card.claimed) {
				throw new Conflict({
					message: "Already claimed. Only its owner or an admin can release it.",
				});
			}

			let collector = this.collector(token);
			let deviceToken: string | undefined;

			if (!collector) {
				collector = { id: newToken(), name: input.name, email: null };

				this.sql
					.prepare("INSERT INTO Collector VALUES (?,?,NULL)")
					.run(collector.id, collector.name);

				deviceToken = this.createDevice(collector.id);
			}

			const result = this.sql
				.prepare(
					"UPDATE Relic SET collectorId=?,acquisitionDate=? WHERE id=? AND ownerId IS NULL AND collectorId IS NULL",
				)
				.run(collector.id, Date.now(), input.relicId);

			if (result.changes !== 1) {
				throw new Conflict({ message: "Already claimed." });
			}

			this.sql
				.prepare(
					`INSERT INTO RelicStory SELECT r.id,?,?,?,${storyOwnerKey} FROM Relic r WHERE r.id=? ON CONFLICT(relicId) DO UPDATE SET name=excluded.name,firstName=excluded.firstName,birthday=excluded.birthday,ownerKey=excluded.ownerKey`,
				)
				.run(input.relicName, input.name, Date.now(), input.relicId);

			return { deviceToken };
		});
	}
	nameRelic(input: typeof Claim.Type, token?: string) {
		this.transaction(() => {
			if (!this.card(input.relicId, token).owned) {
				throw new Unauthorized({
					message: "Open this page on the phone that named it to rename it.",
				});
			}

			this.sql
				.prepare(
					`INSERT INTO RelicStory SELECT r.id,?,?,?,${storyOwnerKey} FROM Relic r WHERE r.id=? ON CONFLICT(relicId) DO UPDATE SET name=excluded.name,firstName=excluded.firstName,birthday=CASE WHEN RelicStory.ownerKey=excluded.ownerKey THEN RelicStory.birthday ELSE excluded.birthday END,ownerKey=excluded.ownerKey`,
				)
				.run(input.relicName, input.name, Date.now(), input.relicId);
		});
	}
	release(id: string, token?: string) {
		this.transaction(() => {
			const owner = this.requireCollector(token);
			const result = this.sql
				.prepare(
					"UPDATE Relic SET collectorId=NULL,ownerId=NULL,ownerEmail=NULL,ownerDeviceId=NULL,acquisitionDate=NULL WHERE id=? AND collectorId=?",
				)
				.run(id, owner.id);

			if (result.changes !== 1) {
				throw new Unauthorized({ message: "This relic is not in your collection." });
			}

			this.sql.prepare("DELETE FROM RelicStory WHERE relicId=?").run(id);
		});
	}
	async migrate(input: { name: string; pin: string }, token?: string) {
		const users = this.many(
			legacyUser,
			"SELECT id,displayName,pinHash FROM User WHERE lower(displayName)=lower(?)",
			input.name,
		);
		const candidates = await Promise.all(
			users.map(async (candidate) => ({
				candidate,
				matches: await compare(input.pin, candidate.pinHash),
			})),
		);
		const user = candidates.find((result) => result.matches)?.candidate;

		if (!user) {
			throw new Unauthorized({
				message: "That name and PIN did not match. Try again or ask an admin.",
			});
		}

		const verifiedUser = user;

		return this.transaction(() => {
			if (this.sql.prepare("SELECT 1 FROM LegacyMigration WHERE userId=?").get(verifiedUser.id)) {
				throw new Conflict({
					message:
						"This collection has already been moved. Use your recovery email or ask an admin.",
				});
			}

			let collector = this.collector(token);
			let deviceToken: string | undefined;

			if (!collector) {
				collector = { id: newToken(), name: verifiedUser.displayName, email: null };

				this.sql
					.prepare("INSERT INTO Collector VALUES (?,?,NULL)")
					.run(collector.id, collector.name);

				deviceToken = this.createDevice(collector.id);
			}

			this.sql
				.prepare("INSERT INTO LegacyMigration VALUES (?,?)")
				.run(verifiedUser.id, collector.id);

			this.sql
				.prepare("UPDATE Relic SET collectorId=? WHERE ownerId=? AND collectorId IS NULL")
				.run(collector.id, verifiedUser.id);

			return { deviceToken };
		});
	}
	createMagic(collectorId: string, email: string) {
		const token = newToken();

		this.sql.prepare("DELETE FROM MagicLink WHERE expiresAt<?").run(Date.now());

		this.sql
			.prepare("INSERT INTO MagicLink VALUES (?,?,?,?)")
			.run(digest(token), collectorId, email, Date.now() + 15 * 60000);

		return token;
	}
	recoveryCollector(email: string) {
		return this.one(ownerSchema, "SELECT * FROM Collector WHERE email=?", email);
	}
	consumeMagic(token: string) {
		return this.transaction(() => {
			const link = this.one(
				Schema.Struct({ collectorId: Schema.String, email: Schema.String }),
				"DELETE FROM MagicLink WHERE tokenHash=? AND expiresAt>? RETURNING collectorId,email",
				digest(token),
				Date.now(),
			);

			if (!link) {
				throw new Rejected({ message: "This link has expired or was used. Request a new one." });
			}

			const existing = this.recoveryCollector(link.email);

			if (existing && existing.id !== link.collectorId) {
				throw new Conflict({
					message: "That email already restores another collection. Ask an admin to combine them.",
				});
			}

			this.sql.prepare("UPDATE Collector SET email=? WHERE id=?").run(link.email, link.collectorId);
			this.sql.prepare("DELETE FROM MagicLink WHERE collectorId=?").run(link.collectorId);

			return this.createDevice(link.collectorId);
		});
	}
	admin(token?: string) {
		return token
			? this.one(
					Schema.Struct({ subject: Schema.String }),
					"SELECT subject FROM AdminSession WHERE tokenHash=? AND expiresAt>?",
					digest(token),
					Date.now(),
				)
			: undefined;
	}
	createAdmin(subject: string) {
		const token = newToken();

		this.sql.prepare("DELETE FROM AdminSession WHERE expiresAt<?").run(Date.now());

		this.sql
			.prepare("INSERT INTO AdminSession VALUES (?,?,?)")
			.run(digest(token), subject, Date.now() + 8 * 3600000);

		return token;
	}
	adminData() {
		return {
			types: this.many(
				Schema.Struct({
					id: Schema.Finite,
					name: Schema.String,
					description: nullableText,
					imageUrl: nullableText,
				}),
				"SELECT id,name,description,imageUrl FROM RelicType ORDER BY id",
			),
			varieties: this.many(
				Variety,
				"SELECT v.id,v.typeId,v.name,t.name typeName,v.description,v.imageUrl FROM RelicVariety v JOIN RelicType t ON t.id=v.typeId ORDER BY v.id",
			),
			ranges: this.many(
				Schema.Struct({
					id: Schema.Finite,
					typeId: Schema.Finite,
					varietyId: Schema.Finite,
					startIndex: Schema.NullOr(Schema.Finite),
					endIndex: Schema.NullOr(Schema.Finite),
					lore: nullableText,
					writtenIndices: nullableText,
				}),
				"SELECT id,typeId,varietyId,startIndex,endIndex,lore,writtenIndices FROM AllocationRange ORDER BY id",
			).map((range) => ({
				...range,
				writtenIndices: Schema.decodeUnknownSync(Schema.Array(Schema.Finite))(
					JSON.parse(range.writtenIndices ?? "[]"),
				),
			})),
			relics: this.many(
				Schema.Struct({
					id: Schema.String,
					name: Schema.String,
					typeId: Schema.NullOr(Schema.Finite),
					varietyId: Schema.NullOr(Schema.Finite),
					indexNumber: Schema.NullOr(Schema.Finite),
					ownerId: nullableText,
					collectorId: nullableText,
					description: nullableText,
					lore: nullableText,
					imageUrl: nullableText,
				}),
				"SELECT id,name,typeId,varietyId,indexNumber,ownerId,collectorId,description,lore,COALESCE(customImageUrl,imageUrl) imageUrl FROM Relic ORDER BY typeId,varietyId,indexNumber",
			),
			collectors: this.many(ownerSchema, "SELECT * FROM Collector ORDER BY name"),
			legacyOwners: this.many(
				Schema.Struct({ id: Schema.String, name: Schema.String }),
				"SELECT id,displayName name FROM User ORDER BY displayName",
			),
		};
	}
	private update(query: string, ...params: SQLInputValue[]) {
		if (this.sql.prepare(query).run(...params).changes !== 1) {
			throw new Missing({ message: "This catalog entry no longer exists. Refresh and try again." });
		}
	}
	administer(command: AdminCommand, subject: string) {
		try {
			this.transaction(() => {
				switch (command.kind) {
					case "type": {
						if (command.id === undefined) {
							this.sql
								.prepare("INSERT INTO RelicType(name,description,imageUrl) VALUES (?,?,?)")
								.run(command.name, command.description || null, command.imageUrl || null);
						} else {
							this.update(
								"UPDATE RelicType SET name=?,description=?,imageUrl=? WHERE id=?",
								command.name,
								command.description || null,
								command.imageUrl || null,
								command.id,
							);
						}

						break;
					}
					case "variety": {
						if (command.id === undefined) {
							this.sql
								.prepare(
									"INSERT INTO RelicVariety(typeId,name,description,imageUrl) VALUES (?,?,?,?)",
								)
								.run(
									command.typeId,
									command.name,
									command.description || null,
									command.imageUrl || null,
								);
						} else {
							this.update(
								"UPDATE RelicVariety SET name=?,description=?,imageUrl=? WHERE id=? AND typeId=?",
								command.name,
								command.description || null,
								command.imageUrl || null,
								command.id,
								command.typeId,
							);
						}

						break;
					}
					case "allocate": {
						if (command.end < command.start || command.end - command.start > 499) {
							throw new Rejected({
								message: "Allocate up to 500 relics, with the end at or after the start.",
							});
						}

						const variety = this.one(
							Schema.Struct({ name: Schema.String, typeName: Schema.String }),
							"SELECT v.name,t.name typeName FROM RelicVariety v JOIN RelicType t ON t.id=v.typeId WHERE v.id=? AND v.typeId=?",
							command.varietyId,
							command.typeId,
						);

						if (!variety) {
							throw new Rejected({ message: "Choose a variety belonging to this type." });
						}

						const occupied = this.sql.prepare(
							"SELECT 1 FROM Relic WHERE typeId=? AND varietyId=? AND indexNumber=? UNION ALL SELECT 1 FROM AllocationRange WHERE typeId=? AND varietyId=? AND startIndex IS NOT NULL AND endIndex IS NOT NULL AND startIndex<=? AND endIndex>=? LIMIT 1",
						);
						const collisions: number[] = [];

						for (let index = command.start; index <= command.end; index++) {
							if (
								occupied.get(
									command.typeId,
									command.varietyId,
									index,
									command.typeId,
									command.varietyId,
									index,
									index,
								)
							) {
								collisions.push(index);
							}
						}

						if (collisions.length > 0) {
							throw new Conflict({
								message: `Catalog numbers ${collisions.join(", ")} are already in use for ${variety.typeName} / ${variety.name}. Use next free numbers to try again.`,
							});
						}

						this.sql
							.prepare(
								"INSERT INTO AllocationRange(typeId,varietyId,startIndex,endIndex,lore) VALUES (?,?,?,?,?)",
							)
							.run(
								command.typeId,
								command.varietyId,
								command.start,
								command.end,
								command.lore || null,
							);

						for (let index = command.start; index <= command.end; index++) {
							this.sql
								.prepare(
									"INSERT INTO Relic(id,typeId,varietyId,indexNumber,name) VALUES (?,?,?,?,?)",
								)
								.run(
									encodeRelicId({ typeId: command.typeId, varietyId: command.varietyId, index }),
									command.typeId,
									command.varietyId,
									index,
									`${variety.typeName} - ${variety.name} #${String(index)}`,
								);
						}

						break;
					}
					case "range":
						this.update(
							"UPDATE AllocationRange SET lore=? WHERE id=?",
							command.lore || null,
							command.id,
						);

						break;
					case "written": {
						const range = this.one(
							Schema.Struct({
								startIndex: Schema.NullOr(Schema.Finite),
								endIndex: Schema.NullOr(Schema.Finite),
								writtenIndices: nullableText,
							}),
							"SELECT startIndex,endIndex,writtenIndices FROM AllocationRange WHERE id=?",
							command.rangeId,
						);

						if (
							!range ||
							(range.startIndex !== null && command.index < range.startIndex) ||
							(range.endIndex !== null && command.index > range.endIndex)
						) {
							throw new Rejected({ message: "Index is outside this allocation." });
						}

						const written = Schema.decodeUnknownSync(Schema.Array(Schema.Finite))(
							JSON.parse(range.writtenIndices ?? "[]"),
						);

						this.sql
							.prepare("UPDATE AllocationRange SET writtenIndices=? WHERE id=?")
							.run(
								JSON.stringify([...new Set([...written, command.index])].toSorted((a, b) => a - b)),
								command.rangeId,
							);

						break;
					}
					case "reassign": {
						let collectorId: string | null = null;
						let ownerId: string | null = null;

						if (command.target.startsWith("collector:")) {
							collectorId = command.target.slice(10);

							if (!this.sql.prepare("SELECT 1 FROM Collector WHERE id=?").get(collectorId)) {
								throw new Rejected({ message: "Collection does not exist." });
							}
						} else if (command.target.startsWith("legacy:")) {
							ownerId = command.target.slice(7);

							if (!this.sql.prepare("SELECT 1 FROM User WHERE id=?").get(ownerId)) {
								throw new Rejected({ message: "Legacy owner does not exist." });
							}

							const migrated = this.one(
								Schema.Struct({ collectorId: Schema.String }),
								"SELECT collectorId FROM LegacyMigration WHERE userId=?",
								ownerId,
							);

							collectorId = migrated?.collectorId ?? null;
						} else if (command.target !== "") {
							throw new Rejected({
								message: "Choose an existing collection or release the relic.",
							});
						}

						if (
							this.sql
								.prepare(
									"UPDATE Relic SET collectorId=?,ownerId=?,ownerEmail=NULL,ownerDeviceId=NULL WHERE id=?",
								)
								.run(collectorId, ownerId, command.relicId).changes !== 1
						) {
							throw new Missing({ message: "Relic not found." });
						}

						if (command.target === "") {
							this.sql.prepare("DELETE FROM RelicStory WHERE relicId=?").run(command.relicId);
						} else {
							this.sql
								.prepare(
									`UPDATE RelicStory SET ownerKey=(SELECT ${storyOwnerKey} FROM Relic r WHERE r.id=RelicStory.relicId),firstName=COALESCE((SELECT name FROM Collector WHERE id=?),(SELECT displayName FROM User WHERE id=?),'') WHERE relicId=?`,
								)
								.run(collectorId, ownerId, command.relicId);
						}

						break;
					}
					case "relic":
						this.update(
							"UPDATE Relic SET name=?,description=?,lore=?,imageUrl=?,customImageUrl=NULL WHERE id=?",
							command.name,
							command.description || null,
							command.lore || null,
							command.imageUrl || null,
							command.relicId,
						);

						break;
					case "set": {
						const id =
							command.id ??
							this.sql
								.prepare("INSERT INTO RelicSet(name,description,imageUrl) VALUES (?,?,?)")
								.run(command.name, command.description || null, command.imageUrl || null)
								.lastInsertRowid;

						if (command.id !== undefined) {
							if (
								this.sql
									.prepare("UPDATE RelicSet SET name=?,description=?,imageUrl=? WHERE id=?")
									.run(command.name, command.description || null, command.imageUrl || null, id)
									.changes !== 1
							) {
								throw new Missing({ message: "Set not found." });
							}

							this.sql.prepare("DELETE FROM SetMember WHERE setId=?").run(id);
						}

						for (const varietyId of new Set(command.varietyIds)) {
							const v = this.one(
								Schema.Struct({ typeId: Schema.Finite }),
								"SELECT typeId FROM RelicVariety WHERE id=?",
								varietyId,
							);

							if (!v) {
								throw new Rejected({ message: "Variety not found." });
							}

							this.sql
								.prepare("INSERT INTO SetMember(setId,typeId,varietyId) VALUES (?,?,?)")
								.run(id, v.typeId, varietyId);
						}

						break;
					}
					case "deleteSet":
						this.sql.prepare("DELETE FROM RelicSet WHERE id=?").run(command.id);

						break;
				}

				this.sql
					.prepare("INSERT INTO AdminAudit(subject,action,createdAt) VALUES (?,?,?)")
					.run(subject, JSON.stringify(command), Date.now());
			});
		} catch (cause) {
			if (
				cause instanceof Error &&
				"errcode" in cause &&
				typeof cause.errcode === "number" &&
				(cause.errcode & 255) === 19
			) {
				if (cause.errcode === 2067 || cause.errcode === 1555) {
					throw new Conflict({
						message: "That catalog entry already exists. Choose a different name or range.",
					});
				}

				throw new Rejected({
					message: "The selected catalog references are invalid. Refresh and try again.",
				});
			}

			throw cause;
		}
	}
}
