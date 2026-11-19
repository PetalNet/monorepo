#!/usr/bin/env -S node --no-warnings
// matrix-search — search or read Janet's Matrix history, encrypted rooms included.
//
// Synapse's /search only indexes unencrypted events, so E2EE rooms used to return
// nothing. Encrypted rooms are now read from a local SQLite FTS5 index that this
// tool fills by paging /messages and decrypting each m.room.encrypted event with
// the megolm session keys the matrix-channel plugin already holds in its crypto
// store (read-only; no new device, no login). Unencrypted rooms still go through
// the server's /search. Results from both are merged by event_id.
//
// Usage:
//   matrix-search <query...>                   search all joined rooms, by relevance
//   matrix-search -r <room> <query...>         scope to one room (room_id or exact room name)
//   matrix-search -s <@user:hs> <query...>     scope to one sender
//   matrix-search -n <N> <query...>            max results (default 20)
//   matrix-search -t <query...>                newest first instead of by relevance
//   matrix-search -r <room> --recent <N>       last N messages in a room, oldest first, no query
//   matrix-search --backfill <N> [-r <room>]   index N more older events per encrypted room
//
// --recent reads the janet-matrix-comms archive first (archive.ts) and fills in
// from the legacy index below only for events the archive lacks.
//
// Index: ~/.claude/state/matrix-search.db (mode 600). Each run first catches every
// encrypted room up to now. The first catch-up of a room reads its newest
// INITIAL_DEPTH events; --backfill goes further back. Events whose megolm session
// the plugin never received print as "(unable to decrypt)" and are retried each run.
import { createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import * as archive from "./archive.ts";
import { emptyToNull } from "./archive.ts";

// Shapes of the JSON other programs hand us: the homeserver, the plugin's session file and spool.
interface EventContent {
	body?: unknown;
	msgtype?: string;
	"m.new_content"?: { body?: unknown };
	algorithm?: string;
	session_id?: string;
	ciphertext?: string;
}
interface MatrixEvent {
	type: string;
	event_id: string;
	room_id?: string;
	sender: string;
	origin_server_ts?: number;
	content?: EventContent;
}
interface ApiJson {
	errcode?: string;
	error?: string;
	joined_rooms?: string[];
	name?: string;
	chunk?: MatrixEvent[];
	end?: string;
	search_categories?: { room_events?: { results?: { result?: MatrixEvent }[] } };
}
interface SpoolLine {
	kind?: unknown;
	event_id?: string;
	room_id?: string;
	sender_id?: string;
	body?: unknown;
	ts?: number;
}
interface Pickle {
	room_id: string;
	pickle: { initial_ratchet: { counter: number; inner: Buffer } };
}
interface Row {
	event_id: string;
	room_id: string;
	sender: string;
	ts: number;
	body: string | null;
}
interface RoomRow {
	room_id: string;
	name: string | null;
}
interface Session {
	roomId: string;
	counter: number;
	parts: Buffer[];
}

const HOME = process.env["HOME"] ?? "";
const PLUGIN = path.join(HOME, ".claude/plugins/matrix-channel");
const SESSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, "rust-session.json"), "utf8")) as {
	homeserver: string;
	access_token: string;
};
const CRYPTO_DB = path.join(PLUGIN, "store/matrix-sdk-crypto.sqlite3");
const SPOOL = path.join(PLUGIN, "inbound-spool.jsonl");
const INDEX = path.join(HOME, ".claude/state/matrix-search.db");
const INITIAL_DEPTH = 2000;
const HS = SESSION.homeserver.replace(/\/$/, "");
const AUTH = { Authorization: `Bearer ${SESSION.access_token}` };

function die(msg: string, code = 1): never {
	console.error(msg);
	process.exit(code);
}

// ---------- args ----------
let limit = 20;
let room = "";
let sender = "";
let order = "rank";
let recent = 0;
let backfill = 0;
const argv = process.argv.slice(2);
const rest: string[] = [];

for (let i = 0; i < argv.length; i++) {
	const a = argv[i] ?? "";

	if (a === "-r") {
		room = argv[++i] ?? "";
	} else if (a === "-s") {
		sender = argv[++i] ?? "";
	} else if (a === "-n") {
		limit = Number(argv[++i]) || 20;
	} else if (a === "-t") {
		order = "recent";
	} else if (a === "--recent") {
		recent = Number(argv[++i]) || 20;
	} else if (a === "--backfill") {
		backfill = Number(argv[++i]) || 1000;
	} else if (a === "--") {
		rest.push(...argv.slice(i + 1));

		break;
	} else if (a.startsWith("-")) {
		die(`unknown flag: ${a}`, 2);
	} else {
		rest.push(a);
	}
}

const query = rest.join(" ").trim();

if (!query && !recent && !backfill) {
	die(
		"usage: matrix-search [-r room] [-s sender] [-n N] [-t] <query>\n       matrix-search -r room --recent N\n       matrix-search --backfill N [-r room]",
		2,
	);
}

if (recent && !room) {
	die("--recent needs -r <room>", 2);
}

// ---------- HTTP ----------
async function api(
	p: string,
	opts: RequestInit = {},
): Promise<{ ok: boolean; status: number; j: ApiJson }> {
	const res = await fetch(`${HS}/_matrix/client/v3${p}`, {
		...opts,
		headers: {
			...AUTH,
			"Content-Type": "application/json",
			...(opts.headers as Record<string, string> | undefined),
		},
	});
	const j = (await res.json().catch(() => ({}))) as ApiJson;

	return { ok: res.ok, status: res.status, j };
}

const enc = encodeURIComponent;
const why = (r: { status: number; j: ApiJson }): string => String(r.j.errcode ?? r.status);

// ---------- index ----------
process.umask(0o077);
fs.mkdirSync(path.dirname(INDEX), { recursive: true });
const db = new DatabaseSync(INDEX);

fs.chmodSync(INDEX, 0o600);

db.exec(`
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS msg (
    id INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, room_id TEXT NOT NULL,
    sender TEXT NOT NULL, ts INTEGER NOT NULL, body TEXT, encrypted_content TEXT);
  CREATE INDEX IF NOT EXISTS msg_room_ts ON msg(room_id, ts);
  CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(body, content='msg', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS msg_ai AFTER INSERT ON msg WHEN new.body IS NOT NULL BEGIN
    INSERT INTO msg_fts(rowid, body) VALUES (new.id, new.body); END;
  CREATE TRIGGER IF NOT EXISTS msg_au AFTER UPDATE OF body ON msg WHEN old.body IS NULL AND new.body IS NOT NULL BEGIN
    INSERT INTO msg_fts(rowid, body) VALUES (new.id, new.body); END;
  CREATE TABLE IF NOT EXISTS room (
    room_id TEXT PRIMARY KEY, name TEXT, encrypted INTEGER NOT NULL,
    newest_ts INTEGER NOT NULL DEFAULT 0, older_token TEXT, history_done INTEGER NOT NULL DEFAULT 0);
`);

const insMsg =
	db.prepare(`INSERT INTO msg(event_id, room_id, sender, ts, body, encrypted_content) VALUES (?,?,?,?,?,?)
  ON CONFLICT(event_id) DO UPDATE SET body = excluded.body, encrypted_content = NULL
  WHERE msg.body IS NULL AND excluded.body IS NOT NULL`);

// ---------- megolm (read-only use of the plugin's crypto store) ----------
const cryptoDb = new DatabaseSync(CRYPTO_DB, { readOnly: true });

cryptoDb.exec("PRAGMA busy_timeout = 5000");

const getSession = cryptoDb.prepare(
	"SELECT room_id, data FROM inbound_group_session WHERE session_id = ?",
);
const sessionCache = new Map<string, Session | null>();

// Minimal MessagePack reader: the rust SDK stores session pickles with rmp-serde.
function unpack(b: Buffer): unknown {
	let p = 0;
	const be = (n: number): number => {
		let v = 0;

		for (let i = 0; i < n; i++) {
			v = v * 256 + (b[p++] ?? 0);
		}

		return v;
	};

	const take = (n: number): Buffer => {
		const v = b.subarray(p, p + n);

		p += n;

		return v;
	};

	const str = (n: number): string => Buffer.from(take(n)).toString("utf8");
	const map = (n: number): Record<string, unknown> => {
		const o: Record<string, unknown> = {};

		for (let i = 0; i < n; i++) {
			const k = r() as string;

			o[k] = r();
		}

		return o;
	};

	const arr = (n: number): unknown[] => {
		const a: unknown[] = [];

		for (let i = 0; i < n; i++) {
			a.push(r());
		}

		return a;
	};

	function r(): unknown {
		const t = b[p++] ?? 0xc1;

		if (t < 0x80) {
			return t;
		}

		if (t >= 0xe0) {
			return t - 256;
		}

		if ((t & 0xf0) === 0x80) {
			return map(t & 15);
		}

		if ((t & 0xf0) === 0x90) {
			return arr(t & 15);
		}

		if ((t & 0xe0) === 0xa0) {
			return str(t & 31);
		}

		switch (t) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xc4:
				return Buffer.from(take(be(1)));
			case 0xc5:
				return Buffer.from(take(be(2)));
			case 0xc6:
				return Buffer.from(take(be(4)));
			case 0xcc:
				return be(1);
			case 0xcd:
				return be(2);
			case 0xce:
				return be(4);
			case 0xcf:
				return be(8);
			case 0xd0: {
				const v = be(1);

				return v > 127 ? v - 256 : v;
			}
			case 0xd9:
				return str(be(1));
			case 0xda:
				return str(be(2));
			case 0xdb:
				return str(be(4));
			case 0xdc:
				return arr(be(2));
			case 0xdd:
				return arr(be(4));
			case 0xde:
				return map(be(2));
			case 0xdf:
				return map(be(4));
			case 0xca:
				return Buffer.from(take(4)).readFloatBE();
			case 0xcb:
				return Buffer.from(take(8)).readDoubleBE();
		}

		throw new Error(`msgpack tag 0x${t.toString(16)}`);
	}

	return r();
}

function loadSession(sessionId: string): Session | null {
	if (sessionCache.has(sessionId)) {
		return sessionCache.get(sessionId) ?? null;
	}

	const row = getSession.get(Buffer.from(sessionId)) as
		| { room_id: string; data: Uint8Array }
		| undefined;
	let s: Session | null = null;

	if (row) {
		const o = unpack(Buffer.from(row.data)) as Pickle;
		const rat = o.pickle.initial_ratchet;

		s = {
			roomId: o.room_id,
			counter: rat.counter >>> 0,
			parts: [0, 1, 2, 3].map((i) => Buffer.from(rat.inner.subarray(i * 32, i * 32 + 32))),
		};
	}

	sessionCache.set(sessionId, s);

	return s;
}

const hmac = (key: Buffer, data: Uint8Array): Buffer =>
	createHmac("sha256", key).update(data).digest();

// Megolm ratchet advance, as in libolm megolm_advance_to().
function advanceTo(s: Session, target: number): Buffer {
	const R = s.parts.slice();
	let counter = s.counter;
	const rehash = (from: number, to: number): void => {
		R[to] = hmac(R[from] ?? Buffer.alloc(0), Buffer.from([to]));
	};

	for (let j = 0; j < 4; j++) {
		const shift = (3 - j) * 8;
		const mask = (shift === 0 ? 0xffffffff : 0xffffffff << shift) >>> 0;
		let steps = ((target >>> shift) - (counter >>> shift)) & 0xff;

		if (steps === 0) {
			if (target < counter) {
				steps = 0x100;
			} else {
				continue;
			}
		}

		while (steps > 1) {
			rehash(j, j);
			steps--;
		}

		for (let k = 3; k >= j; k--) {
			rehash(j, k);
		}

		counter = (target & mask) >>> 0;
	}

	return Buffer.concat(R);
}

function readVarint(b: Buffer, start: number): [number, number] {
	let p = start;
	let v = 0;
	let m = 1;

	for (;;) {
		const x = b[p++] ?? 0;

		v += (x & 0x7f) * m;

		if (x < 0x80) {
			return [v, p];
		}

		m *= 128;
	}
}

// Returns the decrypted event JSON, or null when we hold no usable key.
function decryptMegolm(roomId: string, content: EventContent): MatrixEvent | null {
	if (content.algorithm !== "m.megolm.v1.aes-sha2" || !content.session_id || !content.ciphertext) {
		return null;
	}

	const s = loadSession(content.session_id);

	if (s?.roomId !== roomId) {
		return null;
	}

	const msg = Buffer.from(content.ciphertext, "base64");

	if (msg[0] !== 3 || msg.length < 1 + 8 + 64) {
		return null;
	}

	const end = msg.length - 8 - 64;
	let p = 1;
	let index: number | null = null;
	let ct: Buffer | null = null;

	while (p < end) {
		const [tag, q] = readVarint(msg, p);

		p = q;

		if ((tag & 7) === 0) {
			const [v, q2] = readVarint(msg, p);

			p = q2;

			if (tag >>> 3 === 1) {
				index = v;
			}
		} else if ((tag & 7) === 2) {
			const [len, q2] = readVarint(msg, p);

			p = q2;

			if (tag >>> 3 === 2) {
				ct = msg.subarray(p, p + len);
			}

			p += len;
		} else {
			return null;
		}
	}

	if (index === null || !ct || index < s.counter) {
		return null;
	}

	const keys = Buffer.from(
		hkdfSync("sha256", advanceTo(s, index), Buffer.alloc(0), Buffer.from("MEGOLM_KEYS"), 80),
	);
	const mac = hmac(keys.subarray(32, 64), msg.subarray(0, end)).subarray(0, 8);

	if (!timingSafeEqual(mac, msg.subarray(end, end + 8))) {
		return null;
	}

	try {
		const d = createDecipheriv("aes-256-cbc", keys.subarray(0, 32), keys.subarray(64, 80));
		const ev = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8")) as MatrixEvent;

		return ev.room_id === roomId ? ev : null;
	} catch {
		return null;
	}
}

// ---------- event -> indexed row ----------
function bodyOf(type: string, content: EventContent | undefined): string | undefined {
	if (type !== "m.room.message" || !content) {
		return undefined;
	}

	const nc = content["m.new_content"];

	if (nc && typeof nc.body === "string") {
		return `(edit) ${nc.body}`;
	}

	if (typeof content.body !== "string") {
		return undefined;
	}

	const mt = content.msgtype;

	return mt && mt !== "m.text" && mt !== "m.notice" && mt !== "m.emote"
		? `[${mt}] ${content.body}`
		: content.body;
}

// Index one /messages event. Returns false for events that hold no message text.
function indexEvent(roomId: string, ev: MatrixEvent): boolean {
	let body: string | null | undefined;
	let encrypted: string | null = null;

	if (ev.type === "m.room.encrypted") {
		const dec = decryptMegolm(roomId, ev.content ?? {});

		if (dec) {
			body = bodyOf(dec.type, dec.content);
		} else if (ev.content?.ciphertext) {
			body = null;
			encrypted = JSON.stringify(ev.content);
		}
	} else {
		body = bodyOf(ev.type, ev.content);
	}

	if (body === undefined) {
		return false;
	}

	insMsg.run(ev.event_id, roomId, ev.sender, ev.origin_server_ts ?? 0, body, encrypted);

	return true;
}

// ---------- rooms ----------
async function syncRooms(): Promise<string[]> {
	const r = await api("/joined_rooms");

	if (!r.ok) {
		die(`joined_rooms: ${why(r)} ${r.j.error ?? ""}`);
	}

	const joinedRooms = r.j.joined_rooms ?? [];
	const known = new Set(
		(db.prepare("SELECT room_id FROM room").all() as unknown as RoomRow[]).map((x) => x.room_id),
	);
	const add = db.prepare("INSERT INTO room(room_id, name, encrypted) VALUES (?,?,?)");

	await Promise.all(
		joinedRooms
			.filter((id) => !known.has(id))
			.map(async (id) => {
				const [e, n] = await Promise.all([
					api(`/rooms/${enc(id)}/state/m.room.encryption`),
					api(`/rooms/${enc(id)}/state/m.room.name`),
				]);

				add.run(id, n.ok ? emptyToNull(n.j.name) : null, e.ok ? 1 : 0);
			}),
	);

	return joinedRooms;
}

function resolveRoom(spec: string, joined: string[]): string {
	if (spec.startsWith("!")) {
		return spec;
	}

	const hits = (
		db
			.prepare("SELECT room_id, name FROM room WHERE lower(name) = lower(?)")
			.all(spec) as unknown as RoomRow[]
	).filter((x) => joined.includes(x.room_id));
	const [hit] = hits;

	if (hits.length === 1 && hit) {
		return hit.room_id;
	}

	if (hits.length === 0) {
		die(`no joined room named "${spec}"; pass a room_id (!...)`);
	}

	return die(`room name "${spec}" is ambiguous:\n${hits.map((h) => `  ${h.room_id}`).join("\n")}`);
}

const FILTER = enc(
	JSON.stringify({ types: ["m.room.message", "m.room.encrypted"], lazy_load_members: true }),
);

async function page(roomId: string, from: string | null): Promise<ApiJson> {
	const r = await api(
		`/rooms/${enc(roomId)}/messages?dir=b&limit=100&filter=${FILTER}${from ? `&from=${enc(from)}` : ""}`,
	);

	if (!r.ok) {
		throw new Error(`messages ${roomId}: ${why(r)}`);
	}

	return r.j;
}

// Index everything newer than the room's watermark. First visit reads INITIAL_DEPTH events.
async function catchUp(roomId: string): Promise<void> {
	const st = db
		.prepare("SELECT newest_ts, older_token, history_done FROM room WHERE room_id = ?")
		.get(roomId) as { newest_ts: number };
	const watermark = st.newest_ts;
	let from: string | null = null;
	let newest = watermark;
	let seen = 0;
	let token: string | null = null;
	let done = false;

	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- sequential: each page token comes from the previous page, and rooms backfill one at a time
		const j = await page(roomId, from);
		const chunk = j.chunk ?? [];
		let reached = false;

		db.exec("BEGIN");

		for (const ev of chunk) {
			if (watermark && (ev.origin_server_ts ?? Infinity) <= watermark) {
				reached = true;

				break;
			}

			newest = Math.max(newest, ev.origin_server_ts ?? 0);
			indexEvent(roomId, ev);
			seen++;
		}

		db.exec("COMMIT");

		if (reached) {
			break;
		}

		if (!j.end || chunk.length === 0) {
			done = true;

			break;
		}

		from = j.end;

		if (!watermark && seen >= INITIAL_DEPTH) {
			token = j.end;

			break;
		}
	}

	if (watermark) {
		db.prepare("UPDATE room SET newest_ts = ? WHERE room_id = ?").run(newest, roomId);
	} else {
		db.prepare(
			"UPDATE room SET newest_ts = ?, older_token = ?, history_done = ? WHERE room_id = ?",
		).run(newest, token, done ? 1 : 0, roomId);
	}
}

async function backfillRoom(roomId: string, n: number): Promise<number> {
	const st = db
		.prepare("SELECT older_token, history_done FROM room WHERE room_id = ?")
		.get(roomId) as { older_token: string | null; history_done: number };

	if (st.history_done || !st.older_token) {
		return 0;
	}

	let from: string | null = st.older_token;
	let seen = 0;
	let done = false;

	while (seen < n) {
		// oxlint-disable-next-line no-await-in-loop -- sequential: each page token comes from the previous page, and rooms backfill one at a time
		const j = await page(roomId, from);
		const chunk = j.chunk ?? [];

		db.exec("BEGIN");

		for (const ev of chunk) {
			indexEvent(roomId, ev);
			seen++;
		}

		db.exec("COMMIT");

		if (!j.end || chunk.length === 0) {
			done = true;

			break;
		}

		from = j.end;
	}

	db.prepare("UPDATE room SET older_token = ?, history_done = ? WHERE room_id = ?").run(
		done ? null : from,
		done ? 1 : 0,
		roomId,
	);

	return seen;
}

// Retry events stored as undecryptable; the plugin may have received their keys since.
function retryUndecrypted(): void {
	const rows = db
		.prepare(
			"SELECT event_id, room_id, sender, ts, encrypted_content FROM msg WHERE body IS NULL AND encrypted_content IS NOT NULL",
		)
		.all() as unknown as (Row & { encrypted_content: string })[];

	for (const r of rows) {
		const dec = decryptMegolm(r.room_id, JSON.parse(r.encrypted_content) as EventContent);
		const body = dec && bodyOf(dec.type, dec.content);

		if (body != null) {
			insMsg.run(r.event_id, r.room_id, r.sender, r.ts, body, null);
		}
	}
}

// The plugin's rolling inbound spool: cheap extra coverage, incl. unencrypted rooms.
function ingestSpool(): void {
	let text: string;

	try {
		text = fs.readFileSync(SPOOL, "utf8");
	} catch {
		return;
	}

	db.exec("BEGIN");

	for (const line of text.split("\n")) {
		if (!line) {
			continue;
		}

		let e: SpoolLine;

		try {
			e = JSON.parse(line) as SpoolLine;
		} catch {
			continue;
		}

		if (e.kind || !e.event_id || !String(e.room_id).startsWith("!") || typeof e.body !== "string") {
			continue;
		}

		insMsg.run(e.event_id, e.room_id ?? null, e.sender_id ?? null, e.ts ?? 0, e.body, null);
	}

	db.exec("COMMIT");
}

// ---------- search ----------
function ftsQuery(q: string): string {
	const toks = q.match(/[\p{L}\p{N}_]+/gu) ?? [];

	return toks.map((t) => `"${t}"*`).join(" ");
}

function localSearch(q: string, roomIds: string[] | null): Row[] {
	const fq = ftsQuery(q);

	if (!fq) {
		return [];
	}

	const cond: string[] = [];
	const args: SQLInputValue[] = [fq];

	if (roomIds) {
		cond.push(`m.room_id IN (${roomIds.map(() => "?").join(",")})`);
		args.push(...roomIds);
	}

	if (sender) {
		cond.push("m.sender = ?");
		args.push(sender);
	}

	const sql = `SELECT m.event_id, m.room_id, m.sender, m.ts, m.body FROM msg_fts f JOIN msg m ON m.id = f.rowid
    WHERE msg_fts MATCH ? ${cond.length > 0 ? `AND ${cond.join(" AND ")}` : ""}
    ORDER BY ${order === "recent" ? "m.ts DESC" : "bm25(msg_fts)"} LIMIT ?`;

	return db.prepare(sql).all(...args, limit) as unknown as Row[];
}

async function serverSearch(q: string, roomIds: string[] | null): Promise<Row[]> {
	const f: { limit: number; rooms?: string[]; senders?: string[] } = { limit };

	if (roomIds) {
		f.rooms = roomIds;
	}

	if (sender) {
		f.senders = [sender];
	}

	const r = await api("/search", {
		method: "POST",
		body: JSON.stringify({
			search_categories: {
				room_events: {
					search_term: q,
					keys: ["content.body"],
					order_by: order,
					filter: f,
					event_context: { before_limit: 0, after_limit: 0, include_profile: false },
				},
			},
		}),
	});

	if (!r.ok) {
		console.error(`server /search: ${why(r)} ${r.j.error ?? ""}`);

		return [];
	}

	return (r.j.search_categories?.room_events?.results ?? [])
		.map((x) => x.result)
		.filter((e): e is MatrixEvent => Boolean(e))
		.map((e) => ({
			event_id: e.event_id,
			room_id: e.room_id ?? "",
			sender: e.sender,
			ts: e.origin_server_ts ?? 0,
			body: bodyOf(e.type, e.content) ?? `(no text body; type=${e.type})`,
		}));
}

// ---------- output ----------
const roomName = new Map(
	(db.prepare("SELECT room_id, name FROM room").all() as unknown as RoomRow[]).map((r) => [
		r.room_id,
		r.name,
	]),
);

function roomLabel(id: string): string {
	const name = roomName.get(id);

	return name ? ` (${name})` : "";
}

function print(m: Row): void {
	const t = m.ts ? new Date(m.ts).toISOString().replace("T", " ").slice(0, 16) : "?";

	console.log(`${t}  ${m.sender}  ${m.room_id}${roomLabel(m.room_id)}`);
	console.log(`  ${m.event_id}`);

	console.log(
		(m.body ?? "(unable to decrypt: no megolm session for this event)")
			.split(/\r?\n/)
			.map((l) => `  ${l}`)
			.join("\n"),
	);

	console.log("");
}

// ---------- main ----------
const joined = await syncRooms();

for (const r of db.prepare("SELECT room_id, name FROM room").all() as unknown as RoomRow[]) {
	roomName.set(r.room_id, r.name);
}

const roomId = room ? resolveRoom(room, joined) : "";
const encrypted = new Set(
	(db.prepare("SELECT room_id FROM room WHERE encrypted = 1").all() as unknown as RoomRow[])
		.map((r) => r.room_id)
		.filter((id) => joined.includes(id)),
);

ingestSpool();
retryUndecrypted();
const toCatchUp = roomId ? [roomId] : [...encrypted];

await Promise.all(
	toCatchUp.map((id) =>
		catchUp(id).catch((e: unknown) => {
			console.error(String((e as Error).message || e));
		}),
	),
);

if (backfill) {
	for (const id of roomId ? [roomId] : [...encrypted]) {
		// oxlint-disable-next-line no-await-in-loop -- sequential: each page token comes from the previous page, and rooms backfill one at a time
		const n = await backfillRoom(id, backfill).catch((e: unknown) => {
			console.error(String((e as Error).message || e));

			return 0;
		});

		if (n) {
			console.error(`backfilled ${String(n)} events: ${id}${roomLabel(id)}`);
		}
	}

	if (!query && !recent) {
		process.exit(0);
	}
}

if (recent) {
	const args: SQLInputValue[] = [roomId];
	let sql = "SELECT event_id, room_id, sender, ts, body FROM msg WHERE room_id = ?";

	if (sender) {
		sql += " AND sender = ?";
		args.push(sender);
	}

	let fromArchive: Row[] = [];

	try {
		const adb = archive.openReader();

		if (adb) {
			fromArchive = archive.recent(adb, roomId, recent, sender);
		}
	} catch (e) {
		console.error(`archive unreadable, using the legacy index only: ${(e as Error).message}`);
	}

	const have = new Set(fromArchive.map((m) => m.event_id));
	const legacy = (
		db.prepare(`${sql} ORDER BY ts DESC LIMIT ?`).all(...args, recent) as unknown as Row[]
	).filter((m) => !have.has(m.event_id));
	const rows = [...fromArchive, ...legacy]
		.toSorted((a, b) => b.ts - a.ts)
		.slice(0, recent)
		.toReversed();
	const nArchive = rows.filter((m) => have.has(m.event_id)).length;

	if (rows.length === 0) {
		console.log(`(no messages indexed for ${roomId})`);
	}

	console.log(
		`# last ${String(rows.length)} message(s) in ${roomId}${roomLabel(roomId)}  [archive: ${String(nArchive)}, legacy index: ${String(rows.length - nArchive)}]\n`,
	);

	rows.forEach(print);
	process.exit(0);
}

// Encrypted rooms: local index. Unencrypted rooms: server /search (plus the local spool copy).
const localScope = roomId ? [roomId] : null;
const local = localSearch(query, localScope);
const wantServer = !roomId || !encrypted.has(roomId);
const remote = wantServer ? await serverSearch(query, roomId ? [roomId] : null) : [];
const seen = new Set<string>();
const merged: Row[] = [];

if (order === "recent") {
	for (const m of [...local, ...remote].toSorted((a, b) => b.ts - a.ts)) {
		if (!seen.has(m.event_id)) {
			seen.add(m.event_id);
			merged.push(m);
		}
	}
} else {
	for (let i = 0; i < Math.max(local.length, remote.length); i++) {
		for (const m of [local[i], remote[i]]) {
			if (m && !seen.has(m.event_id)) {
				seen.add(m.event_id);
				merged.push(m);
			}
		}
	}
}

const out = merged.slice(0, limit);

if (out.length === 0) {
	console.log(`(no matches for: ${query})`);
	process.exit(0);
}

console.log(
	`# ${String(out.length)} match(es) for: ${query}  [local index: ${String(local.length)}, server /search: ${String(remote.length)}]\n`,
);

out.forEach(print);
