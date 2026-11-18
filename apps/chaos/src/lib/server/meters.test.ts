import { describe, expect, it } from "vitest";

import { ingestAlerts, publicSafety } from "./alerts";
import { doorDate } from "./door";
import { icsGauge, ingestIcs } from "./ics";
import { chaos, ingestNews } from "./news";
import { openStore } from "./store";
import { gap, type Gauge } from "./weekly";

const address = (input: string | URL | Request): string =>
	input instanceof Request ? input.url : input.toString();
const NOW = new Date("2026-11-18T17:00:00Z");
const TODAY = "2026-11-18";
const hours = (count: number) => new Date(NOW.getTime() + count * 3_600_000);

describe("critical infrastructure", () => {
	const INDEX = [
		'"2026/icsa-26-321-11.json","2026-11-17T07:00:00.000000Z"',
		'"2026/icsma-26-320-01.json","2026-11-16T07:00:00.000000Z"',
		// An update to an older advisory keeps its number, so it is the same advisory.
		'"2026/icsa-26-001-02a.json","2026-11-17T07:00:00.000000Z"',
		'"2026/icsa-26-001-02.json","2026-01-01T07:00:00.000000Z"',
		'"2024/icsa-24-366-01.json","2024-12-31T07:00:00.000000Z"',
		// Not advisories: a folder that disagrees with the number, and another kind of file.
		'"2025/icsa-26-100-01.json","2026-04-10T07:00:00.000000Z"',
		'"2026/index.txt","2026-04-10T07:00:00.000000Z"',
	].join("\n");

	it("dates each advisory from its number and counts an update once", async () => {
		const store = openStore(":memory:");

		await ingestIcs(store, () => Promise.resolve(new Response(INDEX)), NOW);

		expect(store.advisoryCounts("2024-01-01", "2026-12-31")).toEqual(
			new Map([
				["2024-12-31", 1],
				["2026-01-01", 1],
				["2026-11-16", 1],
				["2026-11-17", 1],
			]),
		);
	});

	it("rejects an index with no advisories, so a bad pull keeps the stored list", async () => {
		const store = openStore(":memory:");

		await expect(
			ingestIcs(store, () => Promise.resolve(new Response("<html>rate limited</html>")), NOW),
		).rejects.toThrow();

		expect(icsGauge(store, TODAY, NOW).kind).toBe("stale");

		await ingestIcs(
			store,
			() => Promise.resolve(new Response(INDEX, { headers: { etag: '"a"' } })),
			NOW,
		);

		await expect(
			ingestIcs(store, () => Promise.resolve(new Response("oops")), NOW),
		).rejects.toThrow();

		await expect(
			ingestIcs(store, () => Promise.resolve(new Response("", { status: 500 })), NOW),
		).rejects.toThrow();

		expect(icsGauge(store, TODAY, NOW)).toMatchObject({ kind: "reading", value: 2 });
	});

	it("asks with the stored ETag and treats a 304 as a successful check", async () => {
		const store = openStore(":memory:");
		const seen: (string | null)[] = [];
		const server: typeof fetch = (url, init) => {
			const tag = new Headers(init?.headers).get("if-none-match");

			seen.push(tag);
			expect(address(url)).toContain("cisagov/CSAF");

			return Promise.resolve(
				tag === '"a"'
					? new Response(null, { status: 304 })
					: new Response(INDEX, { headers: { etag: '"a"' } }),
			);
		};

		expect(await ingestIcs(store, server, NOW)).toBe("updated");
		expect(await ingestIcs(store, server, hours(6))).toBe("unchanged");
		expect(seen).toEqual([null, '"a"']);
		expect(icsGauge(store, TODAY, hours(7)).kind).toBe("reading");
	});

	it("has no reading before the first pull or once pulls have failed for 13 hours", async () => {
		const store = openStore(":memory:");

		expect(icsGauge(store, TODAY, NOW)).toEqual({ of: 52, kind: "stale" });
		await ingestIcs(store, () => Promise.resolve(new Response(INDEX)), NOW);
		expect(icsGauge(store, TODAY, hours(12)).kind).toBe("reading");
		expect(icsGauge(store, TODAY, hours(14)).kind).toBe("stale");
	});
});

describe("public safety", () => {
	const feature = (id: string, sent: string, extra: Record<string, unknown> = {}) => ({
		properties: {
			id,
			event: "911 Telephone Outage",
			sent,
			areaDesc: "Example County",
			headline: "911 outage in Example County",
			status: "Actual",
			messageType: "Alert",
			...extra,
		},
	});
	const feed = (features: unknown[]) => () => Promise.resolve(Response.json({ features }));

	it("asks for its own event names and keeps only first, real alerts", async () => {
		const store = openStore(":memory:");
		let asked = "";
		const server: typeof fetch = (url) => {
			asked = address(url);

			return Promise.resolve(
				Response.json({
					features: [
						feature("a", "2026-11-17T10:00:00-06:00"),
						feature("b", "2026-11-17T11:00:00-06:00", { messageType: "Update" }),
						feature("c", "2026-11-17T11:00:00-06:00", { status: "Test" }),
						feature("d", "2026-11-17T11:00:00-06:00", { event: "Winter Storm Warning" }),
					],
				}),
			);
		};

		expect(await ingestAlerts(store, server, NOW)).toBe(1);
		expect(asked).toContain("event=911+Telephone+Outage%2CCivil+Danger+Warning");
		expect(asked).toContain("start=2026-11-11T17%3A00%3A00.000Z");

		expect(publicSafety(store, TODAY, NOW, doorDate).recent).toEqual([
			{
				id: "a",
				event: "911 Telephone Outage",
				sent: "2026-11-17T16:00:00.000Z",
				area: "Example County",
				headline: "911 outage in Example County",
			},
		]);
	});

	it("rejects an answer that is not an alert list", async () => {
		const store = openStore(":memory:");

		await expect(
			ingestAlerts(store, () => Promise.resolve(Response.json({ title: "Bad Request" })), NOW),
		).rejects.toThrow();

		expect(publicSafety(store, TODAY, NOW, doorDate).gauge.kind).toBe("stale");
	});

	it("shows the count with no needle until its own record covers 13 weeks", async () => {
		const store = openStore(":memory:");

		expect(publicSafety(store, TODAY, NOW, doorDate).gauge).toEqual({ of: 12, kind: "stale" });

		await ingestAlerts(store, feed([feature("a", "2026-11-17T16:00:00Z")]), NOW);

		const first = publicSafety(store, TODAY, NOW, doorDate);

		// The first pull reaches back seven days, so the record holds eight days of the 91 needed.
		expect(first.gauge).toEqual({ of: 12, kind: "short", have: 8, need: 91, value: 1 });
		expect(first.recent.map((alert) => alert.id)).toEqual(["a"]);
	});

	it("keeps alerts past the service's seven days and reads once 13 weeks are held", async () => {
		const store = openStore(":memory:");
		const weeks = (count: number) => new Date(NOW.getTime() + count * 7 * 86_400_000);

		await ingestAlerts(store, feed([feature("a", "2026-11-17T16:00:00Z")]), NOW);

		// A pull every few days for 12 weeks: no alert is ever out of the service's reach.
		await Array.from({ length: 23 }, (_, index) => (index + 1) / 2).reduce(
			(before, week) => before.then(() => ingestAlerts(store, feed([]), weeks(week))),
			Promise.resolve(0),
		);

		// The same alert again changes nothing, and the start of the record does not move.
		await ingestAlerts(store, feed([feature("b", "2027-02-09T16:00:00Z")]), weeks(12));

		const reading = publicSafety(store, "2027-02-10", weeks(12), doorDate);

		expect(reading.gauge).toMatchObject({ kind: "reading", value: 1, quieter: 11 });
		expect(reading.recent.map((alert) => alert.id)).toEqual(["b"]);
	});

	it("starts its record over after a gap longer than the service keeps alerts", async () => {
		const store = openStore(":memory:");
		const days = (count: number) => new Date(NOW.getTime() + count * 86_400_000);

		await ingestAlerts(store, feed([]), NOW);
		await ingestAlerts(store, feed([]), days(6));
		expect(publicSafety(store, "2026-11-24", days(6), doorDate).gauge).toMatchObject({ have: 14 });

		// Fifteen days with no pull: whatever was sent in the first eight of them is lost.
		await ingestAlerts(store, feed([]), days(21));

		expect(publicSafety(store, "2026-12-09", days(21), doorDate).gauge).toMatchObject({
			kind: "short",
			have: 8,
		});
	});

	it("leaves out an alert it cannot read and keeps the rest", async () => {
		const store = openStore(":memory:");

		expect(
			await ingestAlerts(
				store,
				feed([
					feature("a", "not a time"),
					feature("b", "2026-11-17T16:00:00Z", { areaDesc: undefined }),
				]),
				NOW,
			),
		).toBe(1);

		expect(publicSafety(store, TODAY, NOW, doorDate).recent).toMatchObject([{ id: "b", area: "" }]);
	});

	it("has no reading once the feed has not been read for three hours", async () => {
		const store = openStore(":memory:");

		await ingestAlerts(store, feed([]), NOW);

		await expect(
			ingestAlerts(store, () => Promise.resolve(new Response("", { status: 503 })), hours(1)),
		).rejects.toThrow();

		expect(publicSafety(store, TODAY, hours(2), doorDate).gauge.kind).toBe("short");
		expect(publicSafety(store, TODAY, hours(4), doorDate).gauge.kind).toBe("stale");
	});
});

describe("the chaos-o-meter", () => {
	const item = (title: string, outlet: string, published = "Tue, 17 Nov 2026 20:00:00 GMT") =>
		`<item><title>${title} - ${outlet}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(title)}</link><pubDate>${published}</pubDate><source url="https://example.com">${outlet}</source></item>`;
	const rss = (items: string[]) =>
		`<rss><channel><title>search</title>${items.join("")}</channel></rss>`;
	/**
	 * A feed that answers every day and word with `count(day)` headlines. The same stories turn up
	 * under every word, unless `apart(day)` says each word finds its own.
	 */
	const counted =
		(
			count: (day: string) => number,
			asked: string[] = [],
			apart: (day: string) => boolean = () => false,
		): typeof fetch =>
		(input) => {
			const url = decodeURIComponent(address(input));
			const day = /after:(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? "";
			const word = apart(day) ? (/intitle:"([^"]+)"/.exec(url)?.[1] ?? "") : "";

			asked.push(day);

			return Promise.resolve(
				new Response(
					rss(
						Array.from({ length: count(day) }, (_, index) =>
							item(`${day} ${word} story ${String(index)}`, "Wire"),
						),
					),
				),
			);
		};
	/** Runs one round at 17:00 UTC on each of `days` days from November 18. */
	const daily = (store: ReturnType<typeof openStore>, feed: typeof fetch, days: number) =>
		Array.from({ length: days }, (_, index) => hours(24 * index)).reduce(
			(before, at) => before.then(() => ingestNews(store, feed, at, noPause)),
			Promise.resolve(0),
		);
	const noPause = () => Promise.resolve();

	it("asks for each word in headlines on one day, and strips the outlet Google appends to a title", async () => {
		const store = openStore(":memory:");
		const asked: string[] = [];
		const feed: typeof fetch = (input) => {
			const url = decodeURIComponent(address(input));

			asked.push(url);

			return Promise.resolve(
				new Response(
					rss(
						url.includes(TODAY)
							? [item("Hospital hit by ransomware &amp; outage", "Example News")]
							: [],
					),
				),
			);
		};

		await ingestNews(store, feed, NOW, noPause);

		expect(asked).toContain(
			'https://news.google.com/rss/search?q=intitle:"data+breach"+after:2026-11-17+before:2026-11-18&hl=en-US&gl=US&ceid=US:en',
		);

		expect(chaos(store, NOW).headlines).toEqual([
			{
				title: "Hospital hit by ransomware & outage",
				outlet: "Example News",
				url: "https://news.google.com/rss/articles/Hospital%20hit%20by%20ransomware%20%26amp%3B%20outage",
				published: "2026-11-17T20:00:00.000Z",
			},
		]);
	});

	it("rejects a page that is not a feed, and never counts it as a quiet day", async () => {
		const store = openStore(":memory:");
		const consent = () =>
			Promise.resolve(new Response("<html>Before you continue to Google</html>"));

		await expect(ingestNews(store, consent, NOW, noPause)).rejects.toThrow();
		expect(chaos(store, NOW).gauge.kind).toBe("stale");
	});

	it("never fills its baseline from the past: the first round counts three days", async () => {
		const store = openStore(":memory:");
		const asked: string[] = [];
		const feed = counted((day) => (day === "2026-11-17" ? 5 : 2), asked);

		expect(chaos(store, NOW).gauge).toEqual({ of: 14, kind: "stale" });
		expect(await ingestNews(store, feed, NOW, noPause)).toBe(3);
		expect(new Set(asked)).toEqual(new Set(["2026-11-16", "2026-11-17", TODAY]));

		const reading = chaos(store, NOW);

		// The same story turns up under all three words and counts once.
		expect(reading).toMatchObject({
			day: "2026-11-17",
			capped: false,
			today: { day: TODAY, articles: 2, final: false },
			gauge: { of: 14, kind: "short", have: 2, need: 15, value: 5 },
		});

		expect(reading.headlines.map((headline) => headline.title)).toEqual([
			"2026-11-18  story 0",
			"2026-11-18  story 1",
		]);

		asked.length = 0;
		expect(await ingestNews(store, feed, hours(1), noPause)).toBe(0);
		expect(await ingestNews(store, feed, hours(3), noPause)).toBe(1);
		expect(new Set(asked)).toEqual(new Set([TODAY]));
	});

	it("starts reading once it holds 14 of its own settled days before the last one", async () => {
		const store = openStore(":memory:");
		const feed = counted((day) => (day === "2026-12-01" ? 5 : 2));

		await daily(store, feed, 13);
		expect(chaos(store, hours(24 * 12)).gauge).toMatchObject({ kind: "short", have: 14, need: 15 });

		await ingestNews(store, feed, hours(24 * 13), noPause);

		expect(chaos(store, hours(24 * 13))).toMatchObject({
			day: "2026-11-30",
			gauge: { of: 14, kind: "reading", value: 2, quieter: 0, level: "quiet" },
		});

		await ingestNews(store, feed, hours(24 * 14), noPause);

		expect(chaos(store, hours(24 * 14))).toMatchObject({
			day: "2026-12-01",
			gauge: { of: 15, kind: "reading", value: 5, quieter: 15, level: "heavy", median: 2 },
		});
	});

	it("skips a day it never counted in time, and never counts a day at the feed's limit as quieter", async () => {
		const store = openStore(":memory:");
		// November 20 hits the limit under each word. December 1 is far louder still.
		const feed = counted(
			(day) => (day === "2026-11-20" || day === "2026-12-01" ? 100 : 2),
			[],
			(day) => day === "2026-12-01",
		);

		await daily(store, feed, 15);

		expect(chaos(store, hours(24 * 14))).toMatchObject({
			day: "2026-12-01",
			capped: true,
			gauge: { of: 15, kind: "reading", value: 300, quieter: 14, level: "heavy" },
		});

		// Four days with no round: three of those days were never counted, and are never filled in.
		const asked: string[] = [];
		const back = hours(24 * 19);

		await ingestNews(
			store,
			counted(() => 2, asked),
			back,
			noPause,
		);

		expect(new Set(asked)).toEqual(new Set(["2026-12-05", "2026-12-06", "2026-12-07"]));

		expect(chaos(store, back)).toMatchObject({
			day: "2026-12-06",
			gauge: { of: 17, kind: "reading" },
		});
	});

	it("keeps reading the last settled day across midnight, then moves on three hours later", async () => {
		const store = openStore(":memory:");
		const feed = counted((day) => (day === "2026-12-02" ? 9 : 2));

		await daily(store, feed, 15);

		// Half past midnight US Pacific on December 3: yesterday has ended but has not settled.
		const justAfter = new Date("2026-12-03T08:30:00Z");

		await ingestNews(store, feed, justAfter, noPause);

		expect(chaos(store, justAfter)).toMatchObject({
			day: "2026-12-01",
			gauge: { kind: "reading", value: 2 },
		});

		const settled = new Date("2026-12-03T12:00:00Z");

		await ingestNews(store, feed, settled, noPause);

		expect(chaos(store, settled)).toMatchObject({
			day: "2026-12-02",
			gauge: { kind: "reading", value: 9, quieter: 16 },
		});
	});

	it("shows no reading after a round that failed part way, then finishes it", async () => {
		const store = openStore(":memory:");
		let calls = 0;
		const flaky: typeof fetch = (input, init) => {
			calls += 1;

			return calls > 3
				? Promise.resolve(new Response("", { status: 429 }))
				: counted(() => 2)(input, init);
		};

		await expect(ingestNews(store, flaky, NOW, noPause)).rejects.toThrow("429");
		// One day was counted, but only a whole round counts as a check.
		expect(chaos(store, NOW).gauge).toEqual({ of: 14, kind: "stale" });

		const asked: string[] = [];

		await ingestNews(
			store,
			counted(() => 2, asked),
			hours(1),
			noPause,
		);

		expect(new Set(asked)).toEqual(new Set(["2026-11-16", TODAY]));
		expect(chaos(store, hours(1)).gauge).toMatchObject({ kind: "short", have: 2 });
	});

	it("leaves out an item it cannot read, and reads CDATA and numbered entities", async () => {
		const store = openStore(":memory:");
		const odd = [
			"<item><title>No link or date - Wire</title></item>",
			'<item><title><![CDATA[Company&#8217;s breach &#x26; fallout - Wire]]></title><link>https://news.google.com/rss/articles/odd</link><pubDate>Wed, 18 Nov 2026 16:00:00 GMT</pubDate><source url="https://example.com">Wire</source></item>',
		];
		const feed: typeof fetch = (input) =>
			Promise.resolve(
				new Response(rss(decodeURIComponent(address(input)).includes(`after:${TODAY}`) ? odd : [])),
			);

		await ingestNews(store, feed, NOW, noPause);

		expect(chaos(store, NOW)).toMatchObject({
			today: { articles: 1 },
			headlines: [{ title: "Company\u2019s breach & fallout", outlet: "Wire" }],
		});
	});

	it("has no reading once the count is five hours old", async () => {
		const store = openStore(":memory:");

		await ingestNews(
			store,
			counted(() => 2),
			NOW,
			noPause,
		);

		expect(chaos(store, hours(4)).gauge.kind).toBe("short");
		expect(chaos(store, hours(6))).toMatchObject({ gauge: { kind: "stale" }, headlines: [] });
	});
});

describe("the headline", () => {
	const at = (quieter: number, of: number): Gauge => ({
		of,
		kind: "reading",
		value: 0,
		quieter,
		level: "quiet",
		median: 0,
		series: [],
	});

	it("compares where the two needles sit, each on its own scale", () => {
		expect(gap(at(28, 28), at(26, 52))).toBe("noise-ahead");
		expect(gap(at(7, 28), at(39, 52))).toBe("risk-ahead");
		expect(gap(at(14, 28), at(38, 52))).toBe("level");
		expect(gap(at(21, 28), at(26, 52))).toBe("noise-ahead");
	});

	it("says nothing when either meter has no reading", () => {
		expect(gap({ of: 28, kind: "stale" }, at(26, 52))).toBeUndefined();
		expect(gap(at(1, 28), { of: 52, kind: "short", have: 1, need: 371, value: 0 })).toBeUndefined();
	});
});
