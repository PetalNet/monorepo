import { mkdirSync } from "node:fs";
import path from "node:path";

import { building } from "$app/environment";
import { MODE_COOKIE, parseMode } from "$lib/mode";
import { ingestKev } from "$lib/server/ingest";
import { watch } from "$lib/server/status/watch";
import { openStore, type Store } from "$lib/server/store";
import type { Handle, ServerInit } from "@sveltejs/kit";

// An unchanged feed answers with no body, so an hourly check costs almost nothing and keeps the
// page from sitting without current data for long after the door turns over.
const HOUR = 60 * 60 * 1000;

let store: Store;

export const init: ServerInit = () => {
	if (building) {
		return;
	}

	const dir = process.env.CHAOS_DATA_DIR ?? "data";

	mkdirSync(dir, { recursive: true });
	store = openStore(path.join(dir, "chaos.db"));

	const pull = async (): Promise<void> => {
		try {
			console.log(`kev: ${await ingestKev(store)}`);
		} catch (error) {
			console.error("kev: pull failed, keeping the stored copy", error);
		}
	};

	// Most status feeds and every probe are a few hundred bytes. The two heavy feeds (AWS and Google
	// Cloud, about 250 kB each) are read once an hour, so the board costs about 15 MB a day.
	const look = async (): Promise<void> => {
		try {
			for (const failure of await watch(store)) {
				console.warn(`status: ${failure}`);
			}
		} catch (error) {
			console.error("status: round failed", error);
		}
	};

	void pull();
	void look();
	setInterval(() => void pull(), HOUR).unref();
	setInterval(() => void look(), HOUR / 6).unref();
};

export const handle: Handle = ({ event, resolve }) => {
	event.locals.store = store;

	// The theme is set on <html> by the server, so a chosen theme never flashes the other one.
	const mode = parseMode(event.cookies.get(MODE_COOKIE));

	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace("%chaos.mode%", mode),
	});
};
