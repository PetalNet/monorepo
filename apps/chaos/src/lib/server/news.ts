import { setTimeout as sleep } from "node:timers/promises";

import type { Store } from "./store";
import { addDays, rank, type Gauge } from "./weekly";

/** The headline words whose daily count is the chaos-o-meter's reading. */
const NEWS_TERMS = ["ransomware", "cyberattack", "data breach"] as const;
/** Google News returns at most this many results, so a term's daily count stops here. */
const NEWS_CAP = 100;
/** The last full day is compared with this many days before it. */
const NEWS_DAYS = 28;
const NEWS_SOURCE = "news";

export interface Headline {
	title: string;
	outlet: string;
	url: string;
	published: string;
}

export interface NewsDay {
	day: string;
	/** Headlines counted across all terms. */
	articles: number;
	/** At least one term hit the feed's limit, so the true count is this or more. */
	capped: boolean;
	/** Counted after the day had ended. */
	final: boolean;
}

/** Google News dates a day in US Pacific time. */
function newsDay(now: Date): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

function newsUrl(term: string, day: string): string {
	const query = `intitle:"${term}" after:${day} before:${addDays(day, 1)}`;

	return `https://news.google.com/rss/search?${new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" }).toString()}`;
}

const ENTITIES = new Map([
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["quot", '"'],
	["apos", "'"],
]);

function unescape(xml: string): string {
	return xml.replaceAll(
		/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos));/gi,
		(whole, decimal, hex, name) => {
			if (typeof name === "string") {
				return ENTITIES.get(name.toLowerCase()) ?? whole;
			}

			const code = typeof decimal === "string" ? Number(decimal) : Number.parseInt(String(hex), 16);

			return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : whole;
		},
	);
}

function tag(item: string, name: string): string | undefined {
	const value = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([^<\\]]*)(?:\\]\\]>)?</${name}>`).exec(
		item,
	)?.[1];

	return value === undefined ? undefined : unescape(value).trim();
}

/**
 * Reads one search feed. A body that is not an RSS channel is rejected, never counted as zero. An
 * item the reader cannot make sense of is left out, so one odd item does not lose the day's count.
 */
function parseNews(xml: string): Headline[] {
	if (!/<channel[\s>]/.test(xml)) {
		throw new TypeError("news feed: not an RSS channel");
	}

	return xml
		.split("<item>")
		.slice(1)
		.flatMap((item) => {
			const outlet = tag(item, "source") ?? "";
			const title = tag(item, "title") ?? "";
			const published = new Date(tag(item, "pubDate") ?? "");
			const url = tag(item, "link") ?? "";

			if (title === "" || !url.startsWith("https://") || Number.isNaN(published.getTime())) {
				return [];
			}

			return [
				{
					// Google appends " - Outlet" to every title.
					title:
						outlet && title.endsWith(` - ${outlet}`) ? title.slice(0, -outlet.length - 3) : title,
					outlet,
					url,
					published: published.toISOString(),
				},
			];
		});
}

const AGENT = "chaos-tracker (news count)";
/** Today's count is refreshed this often. */
const EVERY = 2 * 60 * 60 * 1000;
/** A pause between requests, to stay a polite client. */
const PAUSE = 1500;

/** Runs `work` on each item in turn, never two at once: a courtesy to the feed. */
async function inTurn<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
	await items.reduce((before, item) => before.then(() => work(item)), Promise.resolve());
}

/**
 * Counts one day: the distinct headlines found under any of the words. A story found under two
 * words is one headline.
 */
async function countDay(
	day: string,
	fetcher: typeof fetch,
): Promise<{ articles: number; capped: boolean; headlines: Headline[] }> {
	let capped = false;
	const headlines = new Map<string, Headline>();

	await inTurn(NEWS_TERMS, async (term) => {
		const response = await fetcher(newsUrl(term, day), {
			headers: { "User-Agent": AGENT },
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			await response.body?.cancel();

			throw new Error(`news feed answered ${String(response.status)}`);
		}

		const found = parseNews(await response.text());

		capped ||= found.length >= NEWS_CAP;

		for (const headline of found) {
			headlines.set(headline.url, headline);
		}
	});

	return { articles: headlines.size, capped, headlines: [...headlines.values()] };
}

/**
 * A day's count is final once it was taken this long after the day ended, when indexing has
 * settled.
 */
const SETTLE = 3 * 60 * 60 * 1000;

/**
 * One round: count today so far, and count any earlier day that has no final count yet. The first
 * round therefore fills the whole baseline from the feed's own dated results. Rounds are two hours
 * apart unless a day has never been counted. Returns the number of days counted.
 */
export async function ingestNews(
	store: Store,
	fetcher: typeof fetch = fetch,
	now = new Date(),
	pause: (ms: number) => Promise<void> = sleep,
): Promise<number> {
	const today = newsDay(now);
	const settled = newsDay(new Date(now.getTime() - SETTLE));
	const checked = store.source(NEWS_SOURCE)?.checkedAt;
	const known = new Map(
		store.newsDays(addDays(today, -NEWS_DAYS - 2)).map((day) => [day.day, day]),
	);
	const earlier = Array.from({ length: NEWS_DAYS + 2 }, (_, back) => addDays(today, -back - 1));
	const open = earlier.filter((day) => !known.get(day)?.final);

	if (
		open.every((day) => known.has(day)) &&
		checked &&
		now.getTime() - Date.parse(checked) < EVERY
	) {
		return 0;
	}

	await inTurn(open, async (day) => {
		const { articles, capped } = await countDay(day, fetcher);

		store.saveNewsDay({ day, articles, capped, final: day < settled });
		await pause(PAUSE);
	});

	const { articles, capped, headlines } = await countDay(today, fetcher);

	store.saveNewsDay({ day: today, articles, capped, final: false });

	// Only a whole round counts as a check, so a round that failed part way never looks fresh.
	store.saveHeadlines(
		headlines.toSorted((a, b) => b.published.localeCompare(a.published)).slice(0, 6),
		now,
	);

	return open.length + 1;
}

/** A count older than this means pulls are failing. */
const FRESH = 5 * 60 * 60 * 1000;

export interface Chaos {
	gauge: Gauge;
	/** The day the gauge reads: the last full day. */
	day: string | undefined;
	capped: boolean;
	/** Today so far, which the gauge does not use. */
	today: NewsDay | undefined;
	/** Recent headlines behind the count. News claims, shown as reported and unconfirmed. */
	headlines: Headline[];
	checkedAt: string | undefined;
}

/**
 * The chaos-o-meter: headlines on the last full day against the 28 days before it. Coverage volume
 * measures attention, so it moves this dial and no other.
 */
export function chaos(store: Store, now: Date): Chaos {
	const today = newsDay(now);
	const checkedAt = store.source(NEWS_SOURCE)?.checkedAt;
	const days = store.newsDays(addDays(today, -NEWS_DAYS - 2));
	const base = {
		today: days.find((day) => day.day === today),
		headlines: store.headlines(),
		checkedAt,
	};

	if (!checkedAt || now.getTime() - Date.parse(checkedAt) > FRESH) {
		return {
			...base,
			gauge: { of: NEWS_DAYS, kind: "stale" },
			day: undefined,
			capped: false,
			headlines: [],
		};
	}

	const full = new Map(days.filter((day) => day.final).map((day) => [day.day, day]));
	// Yesterday's count settles a few hours into today. Until then the dial reads the day before.
	const last = full.get(addDays(today, -1)) ?? full.get(addDays(today, -2));
	const wanted = last
		? Array.from({ length: NEWS_DAYS + 1 }, (_, index) => addDays(last.day, index - NEWS_DAYS))
		: [];
	const have = wanted.filter((day) => full.has(day)).length;

	if (!last || have < wanted.length) {
		return {
			...base,
			gauge: {
				of: NEWS_DAYS,
				kind: "short",
				have: last ? have : full.size,
				need: NEWS_DAYS + 1,
				value: last?.articles ?? 0,
			},
			day: last?.day,
			capped: last?.capped ?? false,
		};
	}

	return {
		...base,
		gauge: {
			of: NEWS_DAYS,
			kind: "reading",
			...rank(wanted.map((day) => ({ end: day, value: full.get(day)?.articles ?? 0 }))),
		},
		day: last.day,
		capped: last.capped,
	};
}
