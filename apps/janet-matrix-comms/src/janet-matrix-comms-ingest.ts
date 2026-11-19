#!/usr/bin/env -S node --no-warnings
// Slice 1 writer: copy the matrix-channel plugin's inbound spool into the
// archive. The plugin already appends every decrypted message it delivers to
// inbound-spool.jsonl, so this needs no plugin patch or reload. A systemd path
// unit runs it whenever the spool changes; systemd never runs two at once, so
// there is one writer. Re-reading the whole spool is safe: upserts on event_id.
import fs from "node:fs";
import path from "node:path";

import { emptyToNull, homeDir, openWriter, upsert } from "./archive.ts";

// An empty env value means unset.
const SPOOL =
	emptyToNull(process.env["MATRIX_CHANNEL_SPOOL"]) ??
	path.join(homeDir(), ".claude/plugins/matrix-channel/inbound-spool.jsonl");

interface SpoolLine {
	kind?: unknown;
	event_id?: string;
	room_id?: string;
	body?: unknown;
	sender_id?: unknown;
	sender?: string;
	ts?: number;
	thread_root?: string;
	in_reply_to?: string;
}

// systemd stops watching the spool while this runs, so loop until a pass
// starts and ends on the same spool.
const stamp = (): string => {
	try {
		const s = fs.statSync(SPOOL);

		return [s.ino, s.size, s.mtimeMs].join(":");
	} catch {
		return "";
	}
};

const db = openWriter();
let n: number;
let before: string;

do {
	before = stamp();
	let text = "";

	try {
		text = fs.readFileSync(SPOOL, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			throw e;
		}
	}

	n = 0;
	db.exec("BEGIN");

	for (const line of text.split("\n")) {
		let e: SpoolLine;

		try {
			e = JSON.parse(line) as SpoolLine;
		} catch {
			continue;
		}

		// Reactions, redactions and polls carry `kind`; Discord and Minecraft rooms have no `!` id.
		if (
			e.kind ||
			!String(e.event_id).startsWith("$") ||
			!String(e.room_id).startsWith("!") ||
			typeof e.body !== "string" ||
			typeof e.sender_id !== "string"
		) {
			continue;
		}

		upsert(db, {
			event_id: e.event_id ?? "",
			room_id: e.room_id ?? "",
			body: e.body,
			thread_root: e.thread_root,
			in_reply_to: e.in_reply_to,
			sender: e.sender_id,
			sender_name: e.sender,
			ts: e.ts ?? 0,
		});

		n++;
	}

	db.exec("COMMIT");
} while (stamp() !== before);

console.log(`janet-matrix-comms: upserted ${String(n)} spool message(s)`);
