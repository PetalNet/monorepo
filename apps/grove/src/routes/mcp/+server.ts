import { validateMcpRequest } from "$lib/server/mcp-oauth-runtime";
import { runGrove } from "$lib/server/runtime";
import { handleMcpRequest } from "$lib/server/sprouts/mcp";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	const authorization = await validateMcpRequest(event.request);
	if (authorization instanceof Response) return authorization;
	event.locals.mcpPrincipal = authorization;
	return runGrove(handleMcpRequest(event.request), event);
};
