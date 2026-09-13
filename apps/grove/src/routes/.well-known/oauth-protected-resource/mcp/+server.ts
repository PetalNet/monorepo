import { groveMcpProtectedResourceMetadata } from "$lib/server/mcp-oauth-runtime";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () =>
	Response.json(groveMcpProtectedResourceMetadata(), {
		headers: { "cache-control": "public, max-age=300" },
	});
