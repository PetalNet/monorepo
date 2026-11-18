import { KEV_FEED, parseCatalog } from "./kev";
import type { Store } from "./store";

/**
 * One conditional pull of the KEV feed. CISA's server ignores If-None-Match but answers
 * If-Modified-Since with an empty 304, so an unchanged feed costs no body.
 */
export async function ingestKev(
	store: Store,
	fetchFeed: typeof fetch = fetch,
	now = new Date(),
): Promise<"updated" | "unchanged"> {
	const since = store.lastModified();
	const response = await fetchFeed(KEV_FEED, {
		headers: since ? { "If-Modified-Since": since } : {},
		signal: AbortSignal.timeout(30_000),
	});

	if (response.status === 304) {
		store.markChecked(now);

		return "unchanged";
	}

	if (!response.ok) {
		throw new Error(`KEV feed answered ${String(response.status)}`);
	}

	store.save(parseCatalog(await response.json()), response.headers.get("last-modified"), now);

	return "updated";
}
