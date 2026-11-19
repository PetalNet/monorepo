import { mkdirSync } from "node:fs";
import path from "node:path";

import { building } from "$app/env";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";

import { MODE_COOKIE, parseMode } from "#lib/mode.ts";
import { ingestAlerts } from "#lib/server/alerts.ts";
import { ingestIcs } from "#lib/server/ics.ts";
import { ingestKev } from "#lib/server/ingest.ts";
import { ingestNews } from "#lib/server/news.ts";
import { watch } from "#lib/server/status/watch.ts";
import { openStore, type Store } from "#lib/server/store.ts";

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

	/** After a failed pull, a source that asks often waits this long before it asks again. */
	const BACK_OFF = HOUR / 2;

	/**
	 * Runs one source's pull and logs it. A failed pull changes nothing: the stored copy stays. A
	 * pull never overlaps itself, and `patient` sources back off after a failure.
	 */
	const run = (name: string, pull: () => Promise<unknown>, patient = false) => {
		let running = false;
		let waitUntil = 0;

		return async (): Promise<void> => {
			if (running || Date.now() < waitUntil) {
				return;
			}

			running = true;

			try {
				console.log(`${name}: ${String(await pull())}`);
			} catch (error) {
				waitUntil = patient ? Date.now() + BACK_OFF : 0;
				console.error(`${name}: pull failed, keeping the stored copy`, error);
			} finally {
				running = false;
			}
		};
	};

	const pull = run("kev", () => ingestKev(store));
	const advisories = run("ics", () => ingestIcs(store));
	const alerts = run("alerts", () => ingestAlerts(store));
	// The news count asks at most every two hours and skips the rounds between.
	const news = run("news", () => ingestNews(store), true);

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
	void advisories();
	void alerts();
	void news();
	setInterval(() => void pull(), HOUR).unref();
	setInterval(() => void alerts(), HOUR).unref();
	setInterval(() => void advisories(), 6 * HOUR).unref();

	setInterval(() => {
		void look();
		void news();
	}, HOUR / 6).unref();
};

export const handle: Handle = ({ event, resolve }) => {
	event.locals.store = store;

	// The theme is set on <html> by the server, so a chosen theme never flashes the other one.
	const mode = parseMode(event.cookies.get(MODE_COOKIE));

	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace("%chaos.mode%", mode),
	});
};
