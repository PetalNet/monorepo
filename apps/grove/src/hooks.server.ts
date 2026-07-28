import process from "node:process";

import { disposeGroveRuntime, initializeGroveRuntime } from "$lib/server/runtime";
import type { ServerInit } from "@sveltejs/kit";

export const init: ServerInit = async () => {
	await initializeGroveRuntime().initialize();
	process.once("sveltekit:shutdown", () => {
		void disposeGroveRuntime();
	});
};
