import { homeStream } from "$lib/server/home.js";

// GET /janet/home/events: Server-Sent Events for the home page. Behind Authentik like the
// page itself. no-cache/no-transform + X-Accel-Buffering keep proxies from buffering it.
export function GET({ request }) {
	return new Response(homeStream(request.signal), {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
			connection: "keep-alive",
		},
	});
}
