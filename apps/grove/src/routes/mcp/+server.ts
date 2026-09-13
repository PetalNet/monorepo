import { groveMcpIngress } from "$lib/server/mcp-oauth-runtime";
import { runGrove } from "$lib/server/runtime";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	return runGrove(groveMcpIngress().handle(event.request), event);
};
