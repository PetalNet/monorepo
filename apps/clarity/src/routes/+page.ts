// Universal load — surfaces the URL query params to the page so the search box
// renders the current query server-side (SSR), and a no-JS form submit (the
// form GETs to "/") lands on a shareable /?q=… URL with the query pre-filled.
// Full server-side results SSR is intentionally out of scope: results require a
// same-origin SearXNG fetch (browser → traefik → SearXNG), and the legacy app
// is a JS-required SPA for the result fetch. Home + query echo are the
// meaningful-without-JS layer; the result fetch is the enhancement.

import type { PageLoad } from "./$types";

export const load: PageLoad = ({ url }) => {
	return {
		q: url.searchParams.get("q") ?? "",
		categories: url.searchParams.get("categories") ?? "general",
		priv: url.searchParams.get("private") === "1",
	};
};
