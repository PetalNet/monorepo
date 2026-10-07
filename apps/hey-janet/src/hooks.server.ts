import { error } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";

import { limit } from "#lib/server/security.ts";
export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith("/api/") || event.url.pathname.startsWith("/auth/"))
		limit(`ip:${event.getClientAddress()}`, 600);
	if (
		!["GET", "HEAD", "OPTIONS"].includes(event.request.method) &&
		event.request.headers.get("origin") !== event.url.origin
	)
		error(403, "Request origin did not match. Reload this page and try again.");
	const response = await resolve(event);
	response.headers.set("X-Content-Type-Options", "nosniff");
	response.headers.set("Referrer-Policy", "same-origin");
	response.headers.set("Permissions-Policy", "microphone=(self), camera=()");
	response.headers.set("X-Frame-Options", "DENY");
	if (
		event.url.pathname.startsWith("/api/") ||
		event.url.pathname.startsWith("/admin") ||
		event.url.pathname.startsWith("/auth/")
	)
		response.headers.set("Cache-Control", "no-store");
	return response;
};
