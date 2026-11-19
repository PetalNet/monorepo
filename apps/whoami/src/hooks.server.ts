import type { Handle } from "@sveltejs/kit/hooks";

import { DOM_WATCH_SCRIPT } from "#lib/dom-watch-bootstrap.ts";

// app.html marks the top of <head> with %whoami.domwatch%; the observer has to start there,
// before <body> is parsed, to see what extensions inject while the page loads.
export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		transformPageChunk: ({ html }) => html.replace("%whoami.domwatch%", DOM_WATCH_SCRIPT),
	});
