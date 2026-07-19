import { consoleApi } from "$lib/server/api/instance";

import type { RequestHandler } from "./$types";

// The whole /api/v1 REST surface is served by the framework-agnostic console API core: auth
// chain, CORS, rate limiting, and the command/read/query/assistant/terminal planes.
// SvelteKit owns routing and the process; the core owns request semantics. Sibling routes with
// more specific paths (status, users/[userId]/tier, openapi.json) take precedence over this
// catch-all and keep their SER handlers.
export const fallback: RequestHandler = async ({ request }) => {
	const api = await consoleApi();
	return (
		(await api.fetch(request)) ??
		Response.json(
			{ error: { code: "not_found", message: "route not found", retryable: false } },
			{ status: 404 },
		)
	);
};
