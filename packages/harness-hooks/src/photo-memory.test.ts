import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
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
	discover,
	localVisionUrl,
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

async function fixture(options: { remote?: boolean; scan?: string; secret?: boolean } = {}) {
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
	let generated = 0;
	const server = createServer((req, res) => {
		let body = "";

		req.on("data", (chunk) => (body += String(chunk)));

		req.on("end", () => {
			res.setHeader("Content-Type", "application/json");

			if (req.url === "/api/show") {
				res.end(
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
					images: [readFileSync(file).toString("base64")],
				});

				generated++;

				res.end(
					JSON.stringify({
						done: true,
						response: JSON.stringify({
							description: options.secret
								? "A synthetic credential appears."
								: "A small red square.",
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
});
