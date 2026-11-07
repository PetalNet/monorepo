import { getApp } from "$lib/server/app";
import type { ServerInit } from "@sveltejs/kit";

/** Open the database at startup so migrations and interrupted-job cleanup run before any request. */
export const init: ServerInit = () => {
	getApp();
};
