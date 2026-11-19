import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () =>
	Response.json({
		status: "ok",
		timestamp: new Date().toISOString(),
		service: "slide",
	});
