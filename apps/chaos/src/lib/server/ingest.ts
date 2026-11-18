import { KEV_FEED, parseCatalog } from "./kev";
import type { Store } from "./store";

/**
 * One conditional pull of the KEV feed. An unchanged feed answers 304 with no body, which keeps the
 * daily transfer to a few hundred bytes on most checks.
 */
export async function ingestKev(
	store: Store,
	fetchFeed: typeof fetch = fetch,
	now = new Date(),
): Promise<"updated" | "unchanged"> {
	const etag = store.etag();
	const response = await fetchFeed(KEV_FEED, {
		headers: etag ? { "If-None-Match": etag } : {},
		signal: AbortSignal.timeout(30_000),
	});

	if (response.status === 304) {
		store.markChecked(now);

		return "unchanged";
	}

	if (!response.ok) {
		throw new Error(`KEV feed answered ${String(response.status)}`);
	}

	store.save(parseCatalog(await response.json()), response.headers.get("etag"), now);

	return "updated";
}
