// Janet's home page: ONE markdown document that Janet (the main agent) owns and replaces
// whole through the agent API (set_home / get_home), shown at /janet/home. Stored as a
// single JSON row in the `meta` table, rendered through the shared renderMd (raw HTML is
// dropped at parse, then rehype-sanitize), so there is no stored-XSS path.
//
// Live updates: every setHome() publishes to an in-process emitter (better-sqlite3 pins this
// app to one process, so that is the whole fan-out) and homeStream() turns it into a
// Server-Sent Events body. Framework-free so scripts/test-janet-home.mjs drives the real code.
import { EventEmitter } from "node:events";

import db from "./db.js";
import { renderMd } from "./md.js";

const KEY = "janet_home";

export const HOME_MAX = 24 * 1024; // chars of markdown; the RPC body cap (32 KB) bounds the rest

const bus = new EventEmitter();

bus.setMaxListeners(0);

export function getHome() {
	const row = db.prepare("SELECT value FROM meta WHERE key=?").get(KEY);

	if (!row) {
		return { markdown: "", updated_at: null };
	}

	return JSON.parse(row.value);
}

export function setHome(markdown) {
	const doc = { markdown, updated_at: new Date().toISOString() };

	db.prepare(
		"INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
	).run(KEY, JSON.stringify(doc));

	bus.emit("set", doc);

	return doc;
}

// What the page shows: sanitized HTML plus the timestamp.
export function homeView(doc = getHome()) {
	return { html: renderMd(doc.markdown), updated_at: doc.updated_at };
}

// SSE body: the current document on connect (so a reconnect is self-healing and needs no
// replay), another event on every set, and a `: ka` comment every keepaliveMs so Authentik
// and any proxy see traffic on an idle stream.
export function homeStream(signal, { keepaliveMs = 25_000 } = {}) {
	const enc = new TextEncoder();
	let cleanup = () => {};

	return new ReadableStream({
		start(controller) {
			const send = (text) => {
				try {
					controller.enqueue(enc.encode(text));
				} catch {
					cleanup();
				}
			};

			const push = (doc) => send(`event: home\ndata: ${JSON.stringify(homeView(doc))}\n\n`);
			const ka = setInterval(() => send(": ka\n\n"), keepaliveMs);

			bus.on("set", push);

			cleanup = () => {
				clearInterval(ka);
				bus.off("set", push);

				try {
					controller.close();
				} catch {
					// already closed
				}
			};

			signal?.addEventListener("abort", cleanup, { once: true });
			send("retry: 3000\n\n");
			push(getHome());
		},
		cancel() {
			cleanup();
		},
	});
}
