// janet-matrix-comms: the one decrypted Matrix message archive every Janet tool
// reads. One writer (whoever owns the Matrix device: today the matrix-channel
// plugin, via janet-matrix-comms-ingest), many readers. Writes upsert on
// event_id. The database holds private messages: mode 600, never committed.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// An empty env value means unset.
const ARCHIVE =
	emptyToNull(process.env["JANET_MATRIX_COMMS_DB"]) ??
	path.join(process.env["HOME"] ?? "", ".local/state/janet-matrix-comms/archive.db");

export interface ArchivedMessage {
	event_id: string;
	room_id: string;
	sender: string;
	ts: number;
	body: string;
}

export interface MessageInput {
	event_id: string;
	room_id: string;
	sender: string;
	sender_name?: string | null | undefined;
	ts: number;
	body: string;
	thread_root?: string | null | undefined;
	in_reply_to?: string | null | undefined;
}

export function emptyToNull(v: string | null | undefined): string | null {
	if (v) {
		return v;
	}

	return null;
}

export function openWriter(file = ARCHIVE): DatabaseSync {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.chmodSync(path.dirname(file), 0o700);
	fs.closeSync(fs.openSync(file, "a", 0o600));
	fs.chmodSync(file, 0o600);
	const db = new DatabaseSync(file);

	db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS message (
      event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender TEXT NOT NULL,
      sender_name TEXT, ts INTEGER NOT NULL, body TEXT NOT NULL,
      thread_root TEXT, in_reply_to TEXT);
    CREATE INDEX IF NOT EXISTS message_room_ts ON message(room_id, ts);
  `);

	return db;
}

// Returns null when there is no archive yet, so callers fall back.
export function openReader(file = ARCHIVE): DatabaseSync | null {
	if (!fs.existsSync(file)) {
		return null;
	}

	const db = new DatabaseSync(file, { readOnly: true });

	db.exec("PRAGMA busy_timeout = 5000");

	return db;
}

// `ts` is when the device received the event, not origin_server_ts: the plugin
// spool carries only the former. The slice 4 Hermes writer stores the latter.
export function upsert(db: DatabaseSync, m: MessageInput): void {
	db.prepare(
		`INSERT INTO message(event_id, room_id, sender, sender_name, ts, body, thread_root, in_reply_to)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET room_id = excluded.room_id, sender = excluded.sender,
      sender_name = excluded.sender_name, ts = excluded.ts, body = excluded.body,
      thread_root = excluded.thread_root, in_reply_to = excluded.in_reply_to`,
	).run(
		m.event_id,
		m.room_id,
		m.sender,
		m.sender_name ?? null,
		m.ts,
		m.body,
		emptyToNull(m.thread_root),
		emptyToNull(m.in_reply_to),
	);
}

export function recent(
	db: DatabaseSync,
	roomId: string,
	n: number,
	sender = "",
): ArchivedMessage[] {
	const rows = (sender
		? db
				.prepare(
					"SELECT event_id, room_id, sender, ts, body FROM message WHERE room_id = ? AND sender = ? ORDER BY ts DESC LIMIT ?",
				)
				.all(roomId, sender, n)
		: db
				.prepare(
					"SELECT event_id, room_id, sender, ts, body FROM message WHERE room_id = ? ORDER BY ts DESC LIMIT ?",
				)
				.all(roomId, n)) as unknown as ArchivedMessage[];

	return rows.toReversed();
}
