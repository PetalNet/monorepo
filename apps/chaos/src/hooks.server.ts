import { mkdirSync } from "node:fs";
import path from "node:path";

import { building } from "$app/environment";
import { ingestKev } from "$lib/server/ingest";
import { openStore, type Store } from "$lib/server/store";
import type { Handle, ServerInit } from "@sveltejs/kit";

const SIX_HOURS = 6 * 60 * 60 * 1000;

let store: Store;

export const init: ServerInit = () => {
	if (building) {
		return;
	}

	const dir = process.env.CHAOS_DATA_DIR ?? "data";

	mkdirSync(dir, { recursive: true });
	store = openStore(path.join(dir, "chaos.db"));

	const pull = () =>
		ingestKev(store).then(
			(result) => console.log(`kev: ${result}`),
			(error: unknown) => console.error("kev: pull failed, keeping the stored copy", error),
		);

	void pull();
	setInterval(pull, SIX_HOURS).unref();
};

export const handle: Handle = ({ event, resolve }) => {
	event.locals.store = store;

	return resolve(event);
};
