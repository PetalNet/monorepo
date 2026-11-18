import { describe, expect, it } from "vitest";

import { openStore, type Store } from "../store";
import { board } from "./board";
import {
	parseAws,
	parseAzure,
	parseGoogleCloud,
	parseSlack,
	parseStatuspage,
	SERVICES,
} from "./services";
import { watch } from "./watch";

const NOW = new Date("2026-11-18T17:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe("reading a status page", () => {
	it("keeps the page's own words and maps Statuspage indicators to four levels", () => {
		const page = (indicator: string, description: string) =>
			parseStatuspage(JSON.stringify({ status: { indicator, description } }));

		expect(page("none", "All Systems Operational")).toEqual({
			level: "ok",
			text: "All Systems Operational",
		});

		expect(page("minor", "Minor Service Outage").level).toBe("degraded");
		// Statuspage's own words for "major" are a partial outage, so it is not read as a full one.
		expect(page("major", "Partial System Outage").level).toBe("degraded");
		expect(page("critical", "Major System Outage").level).toBe("outage");
		expect(page("maintenance", "Service Under Maintenance").level).toBe("maintenance");
	});

	it("rejects a page it cannot read instead of guessing a level", () => {
		expect(() =>
			parseStatuspage(JSON.stringify({ status: { indicator: "purple", description: "x" } })),
		).toThrow();

		expect(() => parseStatuspage("{}")).toThrow();
		expect(() => parseStatuspage("<html>blocked</html>")).toThrow();
		expect(() => parseAzure("<html>blocked</html>")).toThrow();
		expect(() => parseAws("{}")).toThrow();
		expect(() => parseGoogleCloud("{}")).toThrow();
	});

	it("reads Slack, Google Cloud, AWS and Azure in their own formats", () => {
		expect(parseSlack(JSON.stringify({ status: "ok", active_incidents: [] })).level).toBe("ok");

		expect(
			parseSlack(
				JSON.stringify({
					status: "active",
					active_incidents: [{ title: "Trouble sending", type: "outage" }],
				}),
			),
		).toEqual({ level: "outage", text: "Trouble sending" });

		const closed = { end: "2026-10-20T12:08:00+00:00", severity: "high", external_desc: "Old" };

		expect(parseGoogleCloud(JSON.stringify([closed])).level).toBe("ok");

		expect(
			parseGoogleCloud(
				JSON.stringify([closed, { severity: "medium", external_desc: "Elevated errors" }]),
			),
		).toEqual({ level: "degraded", text: "Elevated errors" });

		// One product in one region can be "high". The probe cannot speak for it, so never a full outage.
		expect(
			parseGoogleCloud(
				JSON.stringify([{ severity: "high", external_desc: "Down" }, { external_desc: "Slow" }]),
			),
		).toEqual({ level: "degraded", text: "Down (and 1 more)" });

		expect(parseAws(JSON.stringify([{ summary: "Increased error rates" }])).text).toBe(
			"Increased error rates",
		);

		expect(
			parseAzure(
				"<rss><channel><item><title><![CDATA[Storage & DNS]]></title></item></channel></rss>",
			).text,
		).toBe("Storage & DNS");

		expect(
			parseAzure("<rss><channel><item><title>Storage &amp; DNS</title></item></channel></rss>")
				.text,
		).toBe("Storage & DNS");

		expect(() => parseSlack(JSON.stringify({ status: "active", active_incidents: [] }))).toThrow();

		expect(parseAws("[]").level).toBe("ok");

		// A regional event is never read as a full outage: the probe cannot speak for one region.
		expect(
			parseAws(
				JSON.stringify([{ summary: "Region Availability", region_name: "UAE", status: "3" }]),
			),
		).toEqual({
			level: "degraded",
			text: "Region Availability (UAE)",
		});

		expect(parseAzure("<rss><channel><title>Azure Status</title></channel></rss>").level).toBe(
			"ok",
		);

		expect(
			parseAzure(
				"<rss><channel><title>Azure Status</title><item><title>Storage errors</title></item></channel></rss>",
			),
		).toEqual({ level: "degraded", text: "Storage errors" });
	});
});

/** A stand-in for the network: status feeds answer `feeds`, probes answer `probes`. */
function network(options: {
	feed?: (url: string) => Response;
	probe?: (url: string) => Response;
}): typeof fetch {
	const feeds = new Set(SERVICES.map((service) => service.feed));

	return (input) => {
		const url = input instanceof Request ? input.url : input.toString();

		if (feeds.has(url)) {
			return Promise.resolve(options.feed?.(url) ?? calm(url));
		}

		try {
			return Promise.resolve(options.probe?.(url) ?? new Response("", { status: 200 }));
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	};
}

/** Every feed in its own format, all reporting no trouble. */
function calm(url: string): Response {
	if (url.includes("aws")) {
		return new Response("[]");
	}

	if (url.includes("google")) {
		return new Response("[]");
	}

	if (url.includes("azure")) {
		return new Response("<rss><channel></channel></rss>");
	}

	if (url.includes("slack")) {
		return Response.json({ status: "ok", active_incidents: [] });
	}

	return Response.json({ status: { indicator: "none", description: "All Systems Operational" } });
}

const row = (store: Store, id: string, now = NOW) =>
	board(store, now).rows.find((candidate) => candidate.id === id);

describe("the board", () => {
	it("agrees when the page says fine and the probe gets an answer, even a 401", async () => {
		const store = openStore(":memory:");

		expect(
			await watch(
				store,
				network({ feed: calm, probe: () => new Response("", { status: 401 }) }),
				NOW,
			),
		).toEqual([]);

		expect(board(store, NOW).rows.map((entry) => entry.verdict)).toEqual(
			SERVICES.map(() => "agree"),
		);

		expect(row(store, "github")).toMatchObject({
			claim: { level: "ok", text: "All Systems Operational" },
			probe: { reachable: true, fails: 0 },
			target: "api.github.com",
		});
	});

	it("waits for a second failed probe before saying the two differ, and lists that row first", async () => {
		const store = openStore(":memory:");
		const down = network({
			feed: calm,
			probe: (url) => new Response("", { status: url.includes("github") ? 503 : 200 }),
		});

		await watch(store, down, NOW);

		expect(row(store, "github")).toMatchObject({
			verdict: "retrying",
			probe: { detail: "HTTP 503", fails: 1 },
		});

		await watch(store, down, later(10));

		expect(board(store, later(10)).rows[0]).toMatchObject({
			id: "github",
			verdict: "differ",
			probe: { fails: 2 },
		});

		await watch(store, network({ feed: calm }), later(20));

		expect(row(store, "github", later(20))).toMatchObject({
			verdict: "agree",
			probe: { fails: 0 },
		});
	});

	it("counts a probe that cannot connect as a failed probe", async () => {
		const store = openStore(":memory:");
		const dead = network({
			feed: calm,
			probe: (url) => {
				if (url.includes("discord")) {
					throw new TypeError("fetch failed");
				}

				return new Response("");
			},
		});

		await watch(store, dead, NOW);
		await watch(store, dead, later(10));

		expect(row(store, "discord", later(10))).toMatchObject({
			verdict: "differ",
			probe: { reachable: false, detail: "No connection" },
		});
	});

	it("agrees when both see trouble, and differs only when a full outage is reported with a working probe", async () => {
		const store = openStore(":memory:");
		const says = (indicator: string, description: string) =>
			Response.json({ status: { indicator, description } });
		const feed = (url: string) => {
			if (url.includes("githubstatus")) {
				return says("major", "Partial System Outage");
			}

			if (url.includes("zoom")) {
				return says("maintenance", "Service Under Maintenance");
			}

			if (url.includes("twilio") || url.includes("vercel")) {
				return says("critical", "Major System Outage");
			}

			return calm(url);
		};

		const probe = (url: string) => new Response("", { status: url.includes("twilio") ? 502 : 200 });

		await watch(store, network({ feed, probe }), NOW);
		await watch(store, network({ feed, probe }), later(10));

		expect(row(store, "twilio", later(10))?.verdict).toBe("agree");
		expect(row(store, "vercel", later(10))?.verdict).toBe("differ");
		// The page's own words are "Partial System Outage": a working probe does not contradict that.
		expect(row(store, "github", later(10))?.verdict).toBe("partial");
		expect(row(store, "zoom", later(10))?.verdict).toBe("partial");
	});

	it("counts a redirect as an answer and a timeout as a failed probe", async () => {
		const store = openStore(":memory:");
		const probe = (url: string) => {
			if (url.includes("zoom")) {
				throw new DOMException("The operation timed out", "TimeoutError");
			}

			return new Response(null, { status: 302 });
		};

		await watch(store, network({ feed: calm, probe }), NOW);
		expect(row(store, "zoom")?.probe).toMatchObject({ reachable: false, detail: "Timed out" });
		expect(row(store, "aws")?.probe?.reachable).toBe(true);
	});

	it("starts a new run of failures after a long gap, so two failures hours apart are not two in a row", async () => {
		const store = openStore(":memory:");
		const down = network({
			feed: calm,
			probe: (url) => new Response("", { status: url.includes("github") ? 503 : 200 }),
		});

		await watch(store, down, NOW);
		await watch(store, down, later(180));

		expect(row(store, "github", later(180))).toMatchObject({
			verdict: "retrying",
			probe: { fails: 1 },
		});
	});

	it("blames its own network, and no service, when a third of the probes fail at once", async () => {
		const failing = (count: number) => {
			const hosts = new Set(SERVICES.slice(0, count).map((service) => new URL(service.probe).host));

			return network({
				feed: calm,
				probe: (url) => new Response("", { status: hosts.has(new URL(url).host) ? 502 : 200 }),
			});
		};

		const after = async (count: number) => {
			const store = openStore(":memory:");

			await watch(store, failing(count), NOW);
			await watch(store, failing(count), later(10));

			return board(store, later(10));
		};

		// 14 services: four failing is still four separate reports, five is our own network.
		expect(await after(4)).toMatchObject({ blind: false });
		expect((await after(4)).rows.filter((entry) => entry.verdict === "differ")).toHaveLength(4);

		const blind = await after(5);

		expect(blind.blind).toBe(true);
		expect(blind.rows.filter((entry) => entry.verdict === "differ")).toHaveLength(0);
		expect(blind.rows.filter((entry) => entry.verdict === "unknown")).toHaveLength(5);
		expect(blind.rows.filter((entry) => entry.verdict === "agree")).toHaveLength(9);
	});

	it("keeps the last claim when a status page fails, then stops showing it once it is old", async () => {
		const store = openStore(":memory:");

		await watch(store, network({ feed: calm }), NOW);

		const broken = network({
			feed: (url) =>
				url.includes("githubstatus") ? new Response("nope", { status: 500 }) : calm(url),
		});

		expect(await watch(store, broken, later(10))).toEqual(["github status feed answered 500"]);

		expect(row(store, "github", later(10))).toMatchObject({
			verdict: "agree",
			claim: { checkedAt: NOW.toISOString() },
		});

		await watch(store, broken, later(40));
		expect(row(store, "github", later(40))).toMatchObject({ verdict: "unknown", claim: undefined });
	});

	it("has no reading at all before the first round", () => {
		const result = board(openStore(":memory:"), NOW);

		expect(result).toMatchObject({ blind: false, checkedAt: undefined });
		expect(result.rows.every((entry) => entry.verdict === "unknown")).toBe(true);
	});

	it("reads a heavy feed once an hour, and keeps its claim through one failed read", async () => {
		const store = openStore(":memory:");
		let heavy = 0;
		let broken = false;
		const counting = network({
			feed: (url) => {
				if (!url.includes("health.aws")) {
					return calm(url);
				}

				heavy += 1;

				return broken ? new Response("", { status: 503 }) : calm(url);
			},
		});

		await watch(store, counting, NOW);
		await watch(store, counting, later(20));
		await watch(store, counting, later(50));

		expect(heavy).toBe(1);
		broken = true;
		await watch(store, counting, later(60));
		expect(heavy).toBe(2);
		expect(row(store, "aws", later(65))?.claim).toMatchObject({ level: "ok" });
		expect(row(store, "aws", later(125))?.claim).toMatchObject({ level: "ok" });
		expect(row(store, "aws", later(131))?.claim).toBeUndefined();
	});
});

it("reads the AWS feed through its UTF-16 byte-order mark", async () => {
	const store = openStore(":memory:");
	const events = JSON.stringify([{ summary: "Region Availability", region_name: "Bahrain" }]);
	const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(events, "utf16le").swap16()]);

	const feed = (url: string) =>
		url.includes("health.aws")
			? new Response(bytes, { headers: { "content-type": "application/json;charset=utf-16" } })
			: calm(url);

	expect(await watch(store, network({ feed }), NOW)).toEqual([]);

	expect(row(store, "aws")).toMatchObject({
		verdict: "partial",
		claim: { level: "degraded", text: "Region Availability (Bahrain)" },
	});
});
