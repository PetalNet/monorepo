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
			areaDesc: "Boone, MO",
			headline: "911 outage in Boone County",
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
				area: "Boone, MO",
				headline: "911 outage in Boone County",
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

		await ingestAlerts(store, feed([feature("a", "2026-11-17T16:00:00Z")]), NOW);

		const later = new Date("2027-02-10T17:00:00Z");

		// The same alert again changes nothing, and the start of the record does not move.
		await ingestAlerts(
			store,
			feed([feature("a", "2026-11-17T16:00:00Z"), feature("b", "2027-02-09T16:00:00Z")]),
			later,
		);

		const reading = publicSafety(store, "2027-02-10", later, doorDate);

		expect(reading.gauge).toMatchObject({ kind: "reading", value: 1, quieter: 11 });
		expect(reading.recent.map((alert) => alert.id)).toEqual(["b"]);
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
	/** A feed that answers every day and term with `count(day)` headlines. */
	const counted =
		(count: (day: string) => number, asked: string[] = []): typeof fetch =>
		(input) => {
			const url = input instanceof Request ? input.url : input.toString();
			const day = /after:(\d{4}-\d{2}-\d{2})/.exec(decodeURIComponent(url))?.[1] ?? "";

			asked.push(day);

			return Promise.resolve(
				new Response(
					rss(
						Array.from({ length: count(day) }, (_, index) =>
							item(`${day} story ${String(index)}`, "Wire"),
						),
					),
				),
			);
		};
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

	it("fills its baseline on the first round, then only counts today again", async () => {
		const store = openStore(":memory:");
		const asked: string[] = [];
		const feed = counted((day) => (day === "2026-11-17" ? 5 : 2), asked);

		expect(chaos(store, NOW).gauge).toEqual({ of: 28, kind: "stale" });
		expect(await ingestNews(store, feed, NOW, noPause)).toBe(30);

		const reading = chaos(store, NOW);

		// Three words, five headlines each, on the last full day: louder than all 28 days before.
		expect(reading).toMatchObject({
			day: "2026-11-17",
			capped: false,
			today: { day: TODAY, articles: 6, final: false },
			gauge: { kind: "reading", value: 15, quieter: 28, level: "heavy", median: 6 },
		});

		// The same story found under two words is one headline.
		expect(reading.headlines.map((headline) => headline.title)).toEqual([
			"2026-11-18 story 0",
			"2026-11-18 story 1",
		]);

		asked.length = 0;
		expect(await ingestNews(store, feed, hours(1), noPause)).toBe(0);
		expect(await ingestNews(store, feed, hours(3), noPause)).toBe(1);
		expect(new Set(asked)).toEqual(new Set([TODAY]));
	});

	it("counts yesterday again once it has ended, and marks a count at the feed's limit", async () => {
		const store = openStore(":memory:");

		await ingestNews(
			store,
			counted(() => 2),
			NOW,
			noPause,
		);

		const asked: string[] = [];
		const nextDay = new Date("2026-11-19T17:00:00Z");

		await ingestNews(
			store,
			counted((day) => (day === TODAY ? 100 : 2), asked),
			nextDay,
			noPause,
		);

		expect(new Set(asked)).toEqual(new Set([TODAY, "2026-11-19"]));

		expect(chaos(store, nextDay)).toMatchObject({
			day: TODAY,
			capped: true,
			gauge: { kind: "reading", value: 300 },
		});
	});

	it("picks up where a failed first round stopped, and says the history is short meanwhile", async () => {
		const store = openStore(":memory:");
		let calls = 0;
		const flaky: typeof fetch = (input, init) => {
			calls += 1;

			return calls > 30
				? Promise.resolve(new Response("", { status: 429 }))
				: counted(() => 2)(input, init);
		};

		await expect(ingestNews(store, flaky, NOW, noPause)).rejects.toThrow("429");

		expect(chaos(store, NOW).gauge).toEqual({
			of: 28,
			kind: "short",
			have: 10,
			need: 29,
			value: 6,
		});

		const asked: string[] = [];

		await ingestNews(
			store,
			counted(() => 2, asked),
			hours(1),
			noPause,
		);

		expect(new Set(asked).size).toBe(20);
		expect(chaos(store, hours(1)).gauge.kind).toBe("reading");
	});

	it("has no reading once the count is five hours old", async () => {
		const store = openStore(":memory:");

		await ingestNews(
			store,
			counted(() => 2),
			NOW,
			noPause,
		);

		expect(chaos(store, hours(4)).gauge.kind).toBe("reading");
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
