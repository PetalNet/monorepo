import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

// Black box: the real executables under Node type stripping, a fake homeserver, a throwaway HOME,
// invented rooms, users and bodies. The real HOME and archive are never touched.
const run = promisify(execFile);
const here = import.meta.dirname;
const ROOM = "!synthetic:example.org";

const line = (seq: number, extra: Record<string, unknown> = {}): string =>
	`${JSON.stringify({
		sender: "Tester",
		sender_id: "@tester:example.org",
		room_id: ROOM,
		body: `synthetic ${String(seq)}`,
		event_id: `$ev${String(seq)}`,
		thread_root: "",
		in_reply_to: "",
		seq,
		ts: 1_700_000_000_000 + seq * 1000,
		...extra,
	})}\n`;

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const c of cleanups.splice(0)) {
		c();
	}
});

async function fixture(searchHits: unknown[] = []) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "jmc-"));
	const plugin = path.join(home, ".claude/plugins/matrix-channel");

	fs.mkdirSync(path.join(plugin, "store"), { recursive: true });

	new DatabaseSync(path.join(plugin, "store/matrix-sdk-crypto.sqlite3")).exec(
		"CREATE TABLE inbound_group_session (session_id BLOB, room_id TEXT, data BLOB)",
	);

	const server = http.createServer((req, res) => {
		const reply = (code: number, body: unknown) => {
			res.writeHead(code, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};

		const url = req.url ?? "";

		if (url.endsWith("/joined_rooms")) {
			reply(200, { joined_rooms: [ROOM] });

			return;
		}

		if (url.includes("/state/m.room.name")) {
			reply(200, { name: "Synthetic" });

			return;
		}

		if (url.includes("/messages")) {
			reply(200, { chunk: [] });

			return;
		}

		if (url.endsWith("/search")) {
			reply(200, {
				search_categories: { room_events: { results: searchHits.map((result) => ({ result })) } },
			});

			return;
		}

		reply(404, { errcode: "M_NOT_FOUND" });
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	cleanups.push(() => {
		server.close();
		fs.rmSync(home, { recursive: true, force: true });
	});

	fs.writeFileSync(
		path.join(plugin, "rust-session.json"),
		JSON.stringify({
			homeserver: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
			access_token: "fake",
		}),
	);

	const env = { ...process.env, HOME: home, JANET_MATRIX_COMMS_DB: "", MATRIX_CHANNEL_SPOOL: "" };
	const exec = (name: string, args: string[] = []) =>
		run("node", ["--no-warnings", path.join(here, `${name}.ts`), ...args], { env });

	return {
		home,
		spool: path.join(plugin, "inbound-spool.jsonl"),
		db: path.join(home, ".local/state/janet-matrix-comms/archive.db"),
		ingest: () => exec("janet-matrix-comms-ingest"),
		search: async (...args: string[]) => (await exec("matrix-search", args)).stdout,
	};
}

describe("janet-matrix-comms", () => {
	it("a spooled message reaches matrix-search --recent through the archive", async () => {
		const f = await fixture();

		fs.writeFileSync(
			f.spool,
			line(1) +
				line(2) +
				line(3, { kind: "reaction" }) +
				line(4, { room_id: "1234" }) +
				line(6, { sender_id: null }),
		);

		const first = await f.ingest();

		expect(first.stdout).toBe("janet-matrix-comms: upserted 2 spool message(s)\n");
		await f.ingest();
		expect(fs.statSync(f.db).mode & 0o777).toBe(0o600);

		// The plugin trims its spool, so after this only the archive still has $ev1 and $ev2.
		// $ev5 was never ingested; the legacy index picks it up from the spool.
		fs.writeFileSync(f.spool, line(5));
		const out = await f.search("-r", ROOM, "--recent", "5");

		expect(out).toMatch(/\[archive: 2, legacy index: 1\]/);
		expect(out.match(/\$ev\d+/g)).toEqual(["$ev1", "$ev2", "$ev5"]);
	});

	it("re-ingesting upserts on event_id instead of duplicating", async () => {
		const f = await fixture();

		fs.writeFileSync(f.spool, line(1));
		await f.ingest();
		fs.writeFileSync(f.spool, line(1, { body: "edited body" }));
		await f.ingest();

		const rows = new DatabaseSync(f.db, { readOnly: true })
			.prepare("SELECT body, thread_root, sender_name FROM message")
			.all();

		expect(rows).toEqual([{ body: "edited body", thread_root: null, sender_name: "Tester" }]);
	});

	it("ingest with no spool file archives nothing and succeeds", async () => {
		const f = await fixture();
		const out = await f.ingest();

		expect(out.stdout).toBe("janet-matrix-comms: upserted 0 spool message(s)\n");
	});

	it("--recent -s keeps only that sender, oldest first", async () => {
		const f = await fixture();

		fs.writeFileSync(f.spool, line(1) + line(2, { sender_id: "@other:example.org" }) + line(3));
		await f.ingest();
		const out = await f.search("-r", ROOM, "-s", "@tester:example.org", "--recent", "5");

		expect(out.match(/\$ev\d+/g)).toEqual(["$ev1", "$ev3"]);
		expect(out).toMatch(/\[archive: 2, legacy index: 0\]/);
	});

	it("a query merges server /search hits and prints them", async () => {
		const f = await fixture([
			{
				event_id: "$srv1",
				room_id: ROOM,
				sender: "@tester:example.org",
				origin_server_ts: 1_700_000_000_000,
				type: "m.room.message",
				content: { msgtype: "m.text", body: "needle in a synthetic haystack" },
			},
		]);
		const out = await f.search("needle");

		expect(out).toMatch(/1 match\(es\) for: needle {2}\[local index: 0, server \/search: 1\]/);
		expect(out).toContain("$srv1");
		expect(out).toContain("needle in a synthetic haystack");
	});

	it("a query with no hits says so", async () => {
		const f = await fixture();

		expect(await f.search("nothing")).toBe("(no matches for: nothing)\n");
	});
});
