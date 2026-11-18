import type { Store } from "./store";
import { addDays, weekly, type Gauge } from "./weekly";

/**
 * CISA publishes every industrial control system advisory as a CSAF file. This is the index of that
 * publication: one line for each file, newest change first.
 */
const ICS_FEED =
	"https://raw.githubusercontent.com/cisagov/CSAF/develop/csaf_files/OT/white/changes.csv";

export const ICS_SOURCE = "ics";

export interface Advisory {
	/** "icsa-26-321-11", or "icsma-…" for a medical device advisory. */
	id: string;
	/** The day CISA first published it. */
	published: string;
}

const FILE =
	/^"(?<folder>\d{4})\/(?<id>icsm?a-(?<year>\d{2})-(?<dayOfYear>\d{3})-\d+)[a-z]?\.json",/;

/**
 * Reads the index. An advisory's number carries its first publication day (year and day of year),
 * so an update to an old advisory does not count as a new one. A line that is not an advisory file
 * is skipped; an index with no advisories at all is rejected.
 */
function parseAdvisories(csv: string): Advisory[] {
	const advisories = new Map<string, Advisory>();

	for (const line of csv.split("\n")) {
		const { folder = "", id = "", year = "", dayOfYear = "" } = FILE.exec(line)?.groups ?? {};
		const day = Number(dayOfYear);

		if (id !== "" && folder.slice(2) === year && day >= 1 && day <= 366) {
			advisories.set(id, { id, published: addDays(`${folder}-01-01`, day - 1) });
		}
	}

	if (advisories.size === 0) {
		throw new Error("ICS advisory index: no advisories");
	}

	return [...advisories.values()];
}

/** One conditional pull of the index. GitHub answers an unchanged file with an empty 304. */
export async function ingestIcs(
	store: Store,
	fetcher: typeof fetch = fetch,
	now = new Date(),
): Promise<"updated" | "unchanged"> {
	const etag = store.source(ICS_SOURCE)?.etag;
	const response = await fetcher(ICS_FEED, {
		headers: etag ? { "If-None-Match": etag } : {},
		signal: AbortSignal.timeout(30_000),
	});

	if (response.status === 304) {
		store.markSource(ICS_SOURCE, now);

		return "unchanged";
	}

	if (!response.ok) {
		throw new Error(`ICS advisory index answered ${String(response.status)}`);
	}

	store.saveAdvisories(parseAdvisories(await response.text()), response.headers.get("etag"), now);

	return "updated";
}

/** The index is pulled every six hours, so a check older than this means pulls are failing. */
const FRESH = 13 * 60 * 60 * 1000;

/** Advisories published in the seven days ending on `date`, against the 52 weeks before them. */
export function icsGauge(store: Store, date: string, now: Date): Gauge {
	const checkedAt = store.source(ICS_SOURCE)?.checkedAt;

	if (!checkedAt || now.getTime() - Date.parse(checkedAt) > FRESH) {
		return { of: 52, kind: "stale" };
	}

	return weekly(store.advisoryCounts, store.earliestAdvisory(), date);
}
