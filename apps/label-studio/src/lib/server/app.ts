import { env } from "$env/dynamic/private";
import { renderLabel } from "$lib/render";

import { parseConfig, type Config } from "./config.ts";
import { serverFonts } from "./fonts.ts";
import type { Renderer } from "./labels.ts";
import { createPrinter, type Printer } from "./printer.ts";
import { PrintQueue } from "./queue.ts";
import { Store } from "./store.ts";

export interface App {
	config: Config;
	store: Store;
	printer: Printer;
	queue: PrintQueue;
	render: Renderer;
	now: () => Date;
}

function createApp(config: Config): App {
	const store = new Store(config.dataDir);
	const interrupted = store.failInterrupted("Interrupted by a server restart");

	if (interrupted > 0) {
		console.warn(`label-studio: marked ${String(interrupted)} unfinished job(s) as failed`);
	}

	const printer = createPrinter(config.printerUrl);
	const now = (): Date => new Date();

	return {
		config,
		store,
		printer,
		queue: new PrintQueue({ store, printer, now }),
		render: (doc, options) => renderLabel(doc, options, serverFonts),
		now,
	};
}

let app: App | undefined;

/** The process-wide app, built from the environment on first use. */
export function getApp(): App {
	app ??= createApp(parseConfig(env));

	return app;
}
