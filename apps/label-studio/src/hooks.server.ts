import type { ServerInit } from "@sveltejs/kit/hooks";

import { getApp } from "#lib/server/app.ts";

/** Open the database at startup so migrations and interrupted-job cleanup run before any request. */
export const init: ServerInit = () => {
	getApp();
};
