import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe as suite, expect, test } from "vitest";

import {
	describe as describePhoto,
	discover,
	localVisionUrl,
	photoConfig,
	PhotoMemory,
	readPhoto,
	type PhotoConfig,
} from "./photo-memory.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	await Array.fromAsync(cleanups.splice(0), (clean) => clean());
});

test("reads regular images and refuses links and oversized files at the opened descriptor", () => {
	const root = mkdtempSync(path.join(tmpdir(), "photo-read-"));

	try {
		const file = path.join(root, "image.png");
		const link = path.join(root, "replacement.png");

		writeFileSync(file, "synthetic-image");
		expect(readPhoto(file).toString()).toBe("synthetic-image");
		symlinkSync(file, link);
		expect(() => readPhoto(link)).toThrow();
		expect(() => readPhoto(root)).toThrow();
		truncateSync(file, 20 * 1024 * 1024 + 1);
		expect(() => readPhoto(file)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function fixture(
	options: { remote?: boolean; scan?: string; show?: string; generate?: string } = {},
) {
	const root = mkdtempSync(path.join(tmpdir(), "photo-memory-"));

	cleanups.push(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const media = path.join(root, "media");

	mkdirSync(media);
	const file = path.join(media, "example.png");

	writeFileSync(
		file,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
			"base64",
		),
	);

	const history = path.join(root, "history.sqlite");
	const db = new DatabaseSync(history);

	db.exec(
		"CREATE TABLE entry(id INTEGER PRIMARY KEY, direction TEXT, text TEXT, ref TEXT, channel TEXT, ts REAL)",
	);

	db.prepare("INSERT INTO entry VALUES(1,'in',?,'$photo-event','!test-room',1000)").run(
		`[image received — saved to ${file} (image/png). Open it with the Read tool to view it.]`,
	);

	db.close();
	const expectedImage = readFileSync(file).toString("base64");
	let generated = 0;
	const server = createServer((req, res) => {
		let body = "";

		req.on("data", (chunk) => (body += String(chunk)));

		req.on("end", () => {
			res.setHeader("Content-Type", "application/json");

			if (req.url === "/api/show") {
				res.end(
					options.show ??
						JSON.stringify({
							capabilities: ["vision"],
							...(options.remote ? { remote_host: "https://external.example" } : {}),
						}),
				);
			} else {
				const request: unknown = JSON.parse(body);

				expect(request).toMatchObject({
					stream: false,
					keep_alive: 0,
					images: [expectedImage],
				});

				generated++;

				res.end(
					options.generate ??
						JSON.stringify({
							done: true,
							response: JSON.stringify({
								description: "A small red square.",
								tags: ["red", "square"],
							}),
						}),
				);
			}
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	cleanups.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			}),
	);

	const address = server.address();

	if (!address || typeof address === "string") {
		throw new Error("no server port");
	}

	const scanner = path.join(root, "scanner.cjs");

	writeFileSync(
		scanner,
		options.scan ??
			"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.exit(s.includes('Source event: $photo-event')?0:2));",
	);

	const config: PhotoConfig = {
		store: path.join(root, "state.sqlite"),
		notes: path.join(root, "notes"),
		history,
		legacySpool: path.join(root, "absent.jsonl"),
		legacyIndex: path.join(root, "absent-index.sqlite"),
		roots: [media],
		visionUrl: `http://127.0.0.1:${String(address.port)}`,
		model: "local-vision",
		scanner: [process.execPath, scanner],
		limit: 3,
	};

	return { root, config, file, generated: () => generated };
}

suite("photo memories", () => {
	test.each([
		"https://127.0.0.1",
		"http://example.com",
		"http://8.8.8.8",
		"http://169.254.169.254",
		"http://user:pass@10.0.0.1",
		"http://10.0.0.1/?destination=external",
		"http://10.0.0.1/path",
	])("refuses nonlocal or ambiguous endpoint %s", (url) => {
		expect(() => localVisionUrl(url)).toThrow();
	});

	test.each([
		"http://127.0.0.1:11434",
		"http://10.1.2.3",
		"http://192.168.1.1",
		"http://172.16.0.1",
	])("accepts local endpoint %s", (url) => {
		expect(localVisionUrl(url).protocol).toBe("http:");
	});

	test("records event, date and file without exporting captions; retry after restart does not describe twice", async () => {
		const f = await fixture();
		const ledger = new PhotoMemory(f.config);

		expect(discover(f.config)).toEqual([
			{
				file: f.file,
				event: "$photo-event",
				room: "!test-room",
				captured: "1970-01-01T00:16:40.000Z",
				dateSource: "message",
			},
		]);

		expect(await ledger.sweep()).toMatchObject({ discovered: 1, staged: 1, retry: 0 });
		ledger.close();
		const restarted = new PhotoMemory(f.config);

		try {
			expect(await restarted.sweep()).toMatchObject({ discovered: 0, staged: 0 });
			expect(f.generated()).toBe(1);
			const files = readdirSync(f.config.notes);

			expect(files).toHaveLength(1);
			const text = readFileSync(path.join(f.config.notes, files[0] ?? ""), "utf8");

			expect(text).toContain("Source event: $photo-event");
			expect(text).toContain("derived, not independently verified");
			expect(text).toContain("A small red square.");
			expect(text).not.toContain("base64");
			expect(text).not.toContain("Open it with the Read tool");
		} finally {
			restarted.close();
		}
	});

	test("refuses a cloud-backed model before sending pixels", async () => {
		const f = await fixture({ remote: true });
		const ledger = new PhotoMemory(f.config);

		try {
			expect(await ledger.sweep()).toMatchObject({ staged: 0, retry: 1 });
			expect(f.generated()).toBe(0);
			expect(readdirSync(f.config.notes)).toEqual([]);
		} finally {
			ledger.close();
		}
	});

	test.each([
		"process.exit(2)",
		"process.stdout.write('unexpected');process.exit(0)",
		"process.stderr.write('unexpected');process.exit(0)",
	])("scanner failure emits no note and remains retryable: %s", async (scan) => {
		const f = await fixture({ scan });
		const ledger = new PhotoMemory(f.config);

		try {
			expect(await ledger.sweep(1_000_000)).toMatchObject({ staged: 0, retry: 1 });
			expect(readdirSync(f.config.notes)).toEqual([]);
			expect(await ledger.sweep(1_000_001)).toMatchObject({ staged: 0, retry: 0 });
			expect(f.generated()).toBe(1);
		} finally {
			ledger.close();
		}
	});

	test("a refused description creates no note and is not retried every tick", async () => {
		const f = await fixture({ scan: "process.exit(1)" });
		const ledger = new PhotoMemory(f.config);

		try {
			expect(await ledger.sweep()).toMatchObject({ refused: 1, staged: 0 });
			expect(await ledger.sweep()).toMatchObject({ refused: 0, staged: 0 });
			expect(ledger.status()).toEqual([{ state: "refused", count: 1 }]);
			expect(readdirSync(f.config.notes)).toEqual([]);
		} finally {
			ledger.close();
		}
	});

	test("legacy files without a retained event keep honest provenance", async () => {
		const f = await fixture();
		const legacy = path.join(f.root, "legacy");

		mkdirSync(legacy);
		writeFileSync(path.join(legacy, "older.jpg"), "synthetic");
		const photos = discover({ ...f.config, roots: [...f.config.roots, legacy] });

		expect(photos).toHaveLength(2);
		expect(photos[1]).toMatchObject({ event: "", dateSource: "file-modified" });
	});

	test("recovers legacy event metadata from the existing index without reading message bodies", async () => {
		const f = await fixture();
		const legacy = path.join(f.root, "legacy");

		mkdirSync(legacy);
		writeFileSync(path.join(legacy, "_older-event.jpg"), "synthetic");
		const index = new DatabaseSync(f.config.legacyIndex);

		index.exec("CREATE TABLE msg(event_id TEXT,room_id TEXT,ts INTEGER)");
		index.prepare("INSERT INTO msg VALUES(?,?,?)").run("$older-event", "!old-room", 123_456);
		index.close();
		const photos = discover({ ...f.config, roots: [...f.config.roots, legacy] });

		expect(photos[1]).toMatchObject({
			event: "$older-event",
			room: "!old-room",
			captured: "1970-01-01T00:02:03.456Z",
			dateSource: "indexed-event",
		});
	});

	test("survives a partial legacySpool append without aborting discovery and recovers when completed", () => {
		const root = mkdtempSync(path.join(tmpdir(), "photo-spool-"));

		cleanups.push(() => {
			rmSync(root, { recursive: true, force: true });
		});

		const media = path.join(root, "media");

		mkdirSync(media);
		const first = path.join(media, "first.png");
		const second = path.join(media, "second.png");
		const histFile = path.join(media, "hist.png");
		const idxFile = path.join(media, "_idx-ev.png");

		for (const p of [first, second, histFile, idxFile]) {
			writeFileSync(p, "synthetic");
		}

		const history = path.join(root, "history.sqlite");
		const hdb = new DatabaseSync(history);

		hdb.exec(
			"CREATE TABLE entry(id INTEGER PRIMARY KEY, direction TEXT, text TEXT, ref TEXT, channel TEXT, ts REAL)",
		);

		hdb
			.prepare("INSERT INTO entry VALUES(1,'in',?,'$hist-ev','!hroom',1000)")
			.run(`saved ${histFile}`);

		hdb.close();

		const legacyIndex = path.join(root, "index.sqlite");
		const idb = new DatabaseSync(legacyIndex);

		idb.exec("CREATE TABLE msg(event_id TEXT, room_id TEXT, ts INTEGER)");
		idb.prepare("INSERT INTO msg VALUES(?,?,?)").run("$idx-ev", "!iroom", 500_000);
		idb.close();

		const legacySpool = path.join(root, "spool.jsonl");

		writeFileSync(
			legacySpool,
			`${JSON.stringify({ body: `saved ${first}`, event_id: "$sp1", room_id: "!s1", ts: 2000 })}\n{"body":"saved ${second}","event_id":"$sp2"`,
		);

		const config: PhotoConfig = {
			store: path.join(root, "state.sqlite"),
			notes: path.join(root, "notes"),
			history,
			legacySpool,
			legacyIndex,
			roots: [media],
			visionUrl: "http://127.0.0.1:11434",
			model: "local-vision",
			scanner: [],
			limit: 3,
		};

		const initial = new Map(discover(config).map((p) => [p.file, p]));

		expect(initial.get(first)).toMatchObject({ event: "$sp1", dateSource: "message" });
		expect(initial.get(histFile)).toMatchObject({ event: "$hist-ev", dateSource: "message" });
		expect(initial.get(idxFile)).toMatchObject({ event: "$idx-ev", dateSource: "indexed-event" });
		expect(initial.get(second)).toMatchObject({ event: "", dateSource: "file-modified" });

		appendFileSync(legacySpool, ',"room_id":"!s2","ts":3000}\n');
		const completed = new Map(discover(config).map((p) => [p.file, p]));

		expect(completed.get(second)).toMatchObject({
			event: "$sp2",
			room: "!s2",
			dateSource: "message",
		});

		const dirSpool = path.join(root, "spool-dir");

		mkdirSync(dirSpool);
		expect(() => discover({ ...config, legacySpool: dirSpool })).toThrow();
	});

	test("preserves NULL history provenance as empty with accurate missingEvent and rejects invalid source values", async () => {
		const f = await fixture({ scan: "process.exit(0)" });
		const media = f.config.roots[0] ?? "";
		const nullHist = path.join(media, "null-hist.png");
		const literalNullFile = path.join(media, "null.png");
		const idxNullRoom = path.join(media, "_idx-null-room.png");
		const badRowFile = path.join(media, "bad-row.png");

		rmSync(f.file);

		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
			"base64",
		);

		for (const p of [nullHist, literalNullFile, idxNullRoom, badRowFile]) {
			writeFileSync(p, png);
		}

		const hdb = new DatabaseSync(f.config.history);

		hdb.exec("DELETE FROM entry");
		hdb.prepare("INSERT INTO entry VALUES(1,'in',?,NULL,NULL,1000)").run(`saved ${nullHist}`);

		hdb
			.prepare("INSERT INTO entry VALUES(2,'in',?,?,?,1000)")
			.run(`saved ${badRowFile}`, "$bad\nSource event: spoofed", "!room");

		hdb
			.prepare("INSERT INTO entry VALUES(3,'in',?,?,?,1000)")
			.run(`saved ${badRowFile}`, new Uint8Array([1, 2, 3]), "!room");

		hdb
			.prepare("INSERT INTO entry VALUES(4,'in',?,'$bad-ts','!room','not-a-number')")
			.run(`saved ${badRowFile}`);

		hdb.close();

		const spool = path.join(f.root, "boundary-spool.jsonl");

		writeFileSync(
			spool,
			`${JSON.stringify({ body: `saved ${badRowFile}`, event_id: 123, room_id: "!r", ts: 1000 })}\n`,
		);

		f.config.legacySpool = spool;

		const idb = new DatabaseSync(f.config.legacyIndex);

		idb.exec("CREATE TABLE msg(event_id TEXT, room_id TEXT, ts INTEGER)");
		idb.prepare("INSERT INTO msg VALUES(NULL, NULL, 2000)").run();
		idb.prepare("INSERT INTO msg VALUES(?, NULL, 3000)").run("$idx-null-room");
		idb.close();

		const byFile = new Map(discover(f.config).map((p) => [p.file, p]));

		expect(byFile.get(nullHist)).toMatchObject({
			event: "",
			room: "",
			dateSource: "message",
		});

		expect(byFile.get(literalNullFile)).toMatchObject({
			event: "",
			room: "",
			dateSource: "file-modified",
		});

		expect(byFile.get(idxNullRoom)).toMatchObject({
			event: "$idx-null-room",
			room: "",
			dateSource: "indexed-event",
		});

		expect(byFile.get(badRowFile)).toMatchObject({
			event: "",
			room: "",
			dateSource: "file-modified",
		});

		const ledger = new PhotoMemory({ ...f.config, limit: 10 });

		try {
			expect(await ledger.sweep()).toMatchObject({ staged: 4, missingEvent: 3 });

			const notes = readdirSync(f.config.notes).map((name) =>
				readFileSync(path.join(f.config.notes, name), "utf8"),
			);

			expect(notes.some((n) => n.includes("Source event: null") || n.includes("Room: null"))).toBe(
				false,
			);

			expect(notes.some((n) => n.includes("spoofed"))).toBe(false);
		} finally {
			ledger.close();
		}
	});

	test("upgrades pending metadata when better provenance arrives without regressing or touching staged/refused rows", async () => {
		const f = await fixture({ scan: "process.exit(2)" });
		const media = f.config.roots[0] ?? "";
		const png = readFileSync(f.file);
		const late = path.join(media, "late.png");
		const idxUpgrade = path.join(media, "_idx-up.png");
		const kept = path.join(media, "kept.png");
		const stagedFile = path.join(media, "already-staged.png");
		const refusedFile = path.join(media, "already-refused.png");

		writeFileSync(late, png);
		writeFileSync(idxUpgrade, png);
		writeFileSync(kept, png);
		writeFileSync(stagedFile, png);
		writeFileSync(refusedFile, png);

		const hdb = new DatabaseSync(f.config.history);

		hdb
			.prepare("INSERT INTO entry VALUES(2,'in',?,'$kept-ev','!kept-room',2000)")
			.run(`saved ${kept}`);

		hdb.close();

		const ledger = new PhotoMemory({ ...f.config, limit: 10 });

		try {
			await ledger.sweep(1_000_000);

			ledger.db
				.prepare("UPDATE photo SET state='staged' WHERE metadata LIKE '%already-staged.png%'")
				.run();

			ledger.db
				.prepare("UPDATE photo SET state='refused' WHERE metadata LIKE '%already-refused.png%'")
				.run();

			// Upgrade file-modified -> indexed-event first on _idx-up.png while still failing.
			const idb = new DatabaseSync(f.config.legacyIndex);

			idb.exec("CREATE TABLE msg(event_id TEXT, room_id TEXT, ts INTEGER)");
			idb.prepare("INSERT INTO msg VALUES(?,?,?)").run("$idx-up", "!idx-room", 250_000);
			idb.close();

			await ledger.sweep(1_200_000);

			// Remove history provenance for kept.png; add late message provenance for late.png, _idx-up.png, staged, refused.
			const hdb2 = new DatabaseSync(f.config.history);

			hdb2.exec("DELETE FROM entry");

			hdb2
				.prepare("INSERT INTO entry VALUES(3,'in',?,'$late-ev','!late-room',3000)")
				.run(`saved ${late}`);

			hdb2
				.prepare("INSERT INTO entry VALUES(4,'in',?,'$idx-msg-ev','!idx-msg-room',3500)")
				.run(`saved ${idxUpgrade}`);

			hdb2
				.prepare("INSERT INTO entry VALUES(5,'in',?,'$should-not-touch','!x',4000)")
				.run(`saved ${stagedFile}`);

			hdb2
				.prepare("INSERT INTO entry VALUES(6,'in',?,'$should-not-touch-2','!x',5000)")
				.run(`saved ${refusedFile}`);

			hdb2.close();

			ledger.config.scanner = [process.execPath, "-e", "process.exit(0)"];
			const result = await ledger.sweep(2_000_000);

			expect(result).toMatchObject({ staged: 4, missingEvent: 0 });

			const notes = readdirSync(f.config.notes).map((name) =>
				readFileSync(path.join(f.config.notes, name), "utf8"),
			);

			expect(
				notes.some(
					(n) =>
						n.includes(late) && n.includes("Source event: $late-ev") && n.includes("(message)"),
				),
			).toBe(true);

			expect(
				notes.some(
					(n) =>
						n.includes(idxUpgrade) &&
						n.includes("Source event: $idx-msg-ev") &&
						n.includes("(message)"),
				),
			).toBe(true);

			expect(
				notes.some(
					(n) =>
						n.includes(kept) && n.includes("Source event: $kept-ev") && n.includes("(message)"),
				),
			).toBe(true);

			const untouched = ledger.db
				.prepare(
					"SELECT state, metadata FROM photo WHERE state IN ('staged','refused') AND metadata LIKE '%already-%'",
				)
				.all();

			expect(untouched.every((row) => String(row["metadata"]).includes("file-modified"))).toBe(
				true,
			);
		} finally {
			ledger.close();
		}
	});

	test("waits on brief writer locks when opening read-only history and legacyIndex", async () => {
		const f = await fixture();
		const idb = new DatabaseSync(f.config.legacyIndex);

		idb.exec("CREATE TABLE msg(event_id TEXT, room_id TEXT, ts INTEGER)");
		idb.close();

		const lockDuring = async (dbPath: string, sql: string, params: unknown[]) => {
			const child = spawn(
				process.execPath,
				[
					"-e",
					[
						'const { DatabaseSync } = require("node:sqlite");',
						"const db = new DatabaseSync(process.argv[1]);",
						'db.exec("BEGIN EXCLUSIVE");',
						"db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3]));",
						'process.stdout.write("locked\\n");',
						"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);",
						'db.exec("COMMIT");',
						"db.close();",
					].join(" "),
					dbPath,
					sql,
					JSON.stringify(params),
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			const done = new Promise<number | null>((resolve) => {
				child.on("exit", resolve);
			});

			await new Promise<void>((resolve, reject) => {
				let out = "";

				child.stdout.on("data", (chunk: Buffer) => {
					out += chunk.toString("utf8");

					if (out.includes("locked\n")) {
						resolve();
					}
				});

				child.on("error", reject);

				child.on("exit", (code) => {
					if (!out.includes("locked\n")) {
						reject(new Error(`lock helper exited ${String(code)}`));
					}
				});
			});

			return { done };
		};

		const media = f.config.roots[0] ?? "";
		const lockedHistFile = path.join(media, "locked-hist.png");
		const lockedIdxFile = path.join(media, "_locked-idx.png");

		writeFileSync(lockedHistFile, "synthetic");
		writeFileSync(lockedIdxFile, "synthetic");

		const histLock = await lockDuring(
			f.config.history,
			"INSERT INTO entry VALUES(2,'in',?,'$locked-h','!lh',2000)",
			[`saved ${lockedHistFile}`],
		);
		const histFound = new Map(discover(f.config).map((p) => [p.file, p]));

		expect(await histLock.done).toBe(0);
		expect(histFound.get(lockedHistFile)).toMatchObject({ event: "$locked-h" });

		const idxLock = await lockDuring(f.config.legacyIndex, "INSERT INTO msg VALUES(?,?,?)", [
			"$locked-idx",
			"!li",
			3000,
		]);
		const idxFound = new Map(discover(f.config).map((p) => [p.file, p]));

		expect(await idxLock.done).toBe(0);
		expect(idxFound.get(lockedIdxFile)).toMatchObject({ event: "$locked-idx" });
	});

	test("orders untouched rows before retries so failing rows never starve fresh work", async () => {
		const f = await fixture({
			scan: "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.exit(s.includes('fail-')?2:0));",
		});
		const media = f.config.roots[0] ?? "";
		const png = readFileSync(f.file);

		rmSync(f.file);

		for (const name of ["fail-1.png", "fail-2.png", "fail-3.png"]) {
			writeFileSync(path.join(media, name), png);
		}

		const ledger = new PhotoMemory(f.config);

		try {
			const t0 = 1_000_000;

			expect(await ledger.sweep(t0)).toMatchObject({ discovered: 3, staged: 0, retry: 3 });

			for (const name of ["ok-1.png", "ok-2.png", "ok-3.png", "ok-4.png"]) {
				writeFileSync(path.join(media, name), png);
			}

			// Advance past max 6h retry backoff so old failing rows are also eligible.
			const t1 = t0 + 7 * 3_600_000;

			expect(await ledger.sweep(t1)).toMatchObject({ discovered: 4, staged: 3, retry: 0 });
			expect(await ledger.sweep(t1 + 1)).toMatchObject({ discovered: 0, staged: 1, retry: 2 });
			expect(readdirSync(f.config.notes)).toHaveLength(4);
		} finally {
			ledger.close();
		}
	});

	test("allows /api/show metadata above 64KiB while bounding oversized/invalid show and generate responses", async () => {
		const largeShow = await fixture({
			show: JSON.stringify({ capabilities: ["vision"], template: "x".repeat(96 * 1024) }),
		});
		const ledger = new PhotoMemory(largeShow.config);

		try {
			expect(await ledger.sweep()).toMatchObject({ staged: 1, retry: 0 });
			expect(largeShow.generated()).toBe(1);
		} finally {
			ledger.close();
		}

		const hugeShow = await fixture({
			show: JSON.stringify({
				capabilities: ["vision"],
				template: "x".repeat(2 * 1024 * 1024 + 1024),
			}),
		});

		await expect(describePhoto(hugeShow.config, readFileSync(hugeShow.file))).rejects.toThrow();
		expect(hugeShow.generated()).toBe(0);

		const badShow = await fixture({ show: "{not-valid-json" });

		await expect(describePhoto(badShow.config, readFileSync(badShow.file))).rejects.toThrow();
		expect(badShow.generated()).toBe(0);

		const hugeGenerate = await fixture({
			generate: JSON.stringify({
				done: true,
				response: JSON.stringify({ description: "x".repeat(70 * 1024), tags: ["a"] }),
			}),
		});

		await expect(
			describePhoto(hugeGenerate.config, readFileSync(hugeGenerate.file)),
		).rejects.toThrow();
	});

	test("hardens config defaults, HERMES_HOME, 0600 store permissions, and anchored path matching", async () => {
		const f = await fixture();
		const home = path.join(f.root, "home");

		mkdirSync(home);
		const savedEnv = { ...process.env };

		try {
			process.env["HOME"] = home;
			process.env["HERMES_HOME"] = "";
			process.env["PHOTO_MEMORY_DIR"] = "";
			process.env["PHOTO_HISTORY"] = "";
			process.env["PHOTO_LEGACY_SPOOL"] = "";
			process.env["PHOTO_LEGACY_INDEX"] = "";
			process.env["FOLD_SECRET_SCANNER_ARGV"] = "";
			process.env["PHOTO_MEDIA_ROOTS"] = "";

			const defaults = photoConfig();

			expect(defaults.store).toBe(path.join(home, ".local/share/photo-memory/state.sqlite"));
			expect(defaults.notes).toBe(path.join(home, ".local/share/photo-memory/notes"));
			expect(defaults.history).toBe(path.join(home, ".hermes-janet/cc-link/history.db"));

			expect(defaults.legacySpool).toBe(
				path.join(home, ".claude/plugins/matrix-channel/inbound-spool.jsonl"),
			);

			expect(defaults.legacyIndex).toBe(path.join(home, ".claude/state/matrix-search.db"));
			expect(defaults.roots[0]).toBe(path.join(home, ".hermes-janet/cc-link/media"));
			expect(defaults.scanner).toEqual([]);

			process.env["HERMES_HOME"] = path.join(f.root, "custom-hermes");
			const customHermes = photoConfig();

			expect(customHermes.history).toBe(path.join(f.root, "custom-hermes/cc-link/history.db"));
			expect(customHermes.roots[0]).toBe(path.join(f.root, "custom-hermes/cc-link/media"));

			process.env["PHOTO_MEMORY_DIR"] = "relative-dir";
			expect(() => photoConfig()).toThrow("invalid-config");

			expect(() => photoConfig({ HOME: home, HERMES_HOME: "relative-hermes" })).toThrow(
				"invalid-config",
			);

			expect(() => photoConfig({ HOME: home, PHOTO_HISTORY: "relative-history" })).toThrow(
				"invalid-config",
			);
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in savedEnv)) {
					Reflect.deleteProperty(process.env, key);
				}
			}

			Object.assign(process.env, savedEnv);
		}

		// Protect existing state database with 0600.
		writeFileSync(f.config.store, "", { mode: 0o644 });
		chmodSync(f.config.store, 0o644);
		const ledger = new PhotoMemory(f.config);

		ledger.close();
		expect(statSync(f.config.store).mode & 0o777).toBe(0o600);

		// Avoid unanchored prefix matches like a.png vs a.png.webp while preserving sentence punctuation.
		const media = f.config.roots[0] ?? "";
		const prefixFile = path.join(media, "a.png");
		const longerFile = path.join(media, "a.png.webp");
		const sentenceFile = path.join(media, "b.png");

		writeFileSync(prefixFile, "a");
		writeFileSync(longerFile, "b");
		writeFileSync(sentenceFile, "c");
		const hdb = new DatabaseSync(f.config.history);

		hdb
			.prepare("INSERT INTO entry VALUES(2,'in',?,'$webp-ev','!room',2000)")
			.run(`[image received — saved to ${longerFile} (image/webp).]`);

		hdb
			.prepare("INSERT INTO entry VALUES(3,'in',?,'$sent-ev','!room',3000)")
			.run(`See ${sentenceFile}.`);

		hdb.close();

		const byFile = new Map(discover(f.config).map((p) => [p.file, p]));

		expect(byFile.get(longerFile)).toMatchObject({ event: "$webp-ev", dateSource: "message" });
		expect(byFile.get(prefixFile)).toMatchObject({ event: "", dateSource: "file-modified" });
		expect(byFile.get(sentenceFile)).toMatchObject({ event: "$sent-ev", dateSource: "message" });
	});
});
