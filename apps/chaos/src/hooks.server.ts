import { mkdirSync } from "node:fs";
import path from "node:path";

import { building } from "$app/environment";
import { ingestKev } from "$lib/server/ingest";
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

	void pull();
	setInterval(() => void pull(), HOUR).unref();
};

export const handle: Handle = ({ event, resolve }) => {
	event.locals.store = store;

	return resolve(event);
};
