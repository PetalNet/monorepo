import { describe, expect, it } from "vitest";

import { ingestKev } from "./ingest";
import { parseCatalog, worst, type KevEntry } from "./kev";
import { openStore } from "./store";

const row = (cveID: string, over: Record<string, string> = {}) => ({
	cveID,
	vendorProject: "Acme",
	product: "Widget",
	vulnerabilityName: `${cveID} name`,
	shortDescription: "desc",
	dateAdded: "2026-11-18",
	dueDate: "2026-12-09",
	knownRansomwareCampaignUse: "Unknown",
	...over,
});

const feed = (rows: unknown[], etag = '"v1"') =>
	new Response(JSON.stringify({ vulnerabilities: rows }), { headers: { etag } });

describe("worst", () => {
	const [plain, urgent, ransom] = parseCatalog({
		vulnerabilities: [
			row("CVE-2026-1"),
			row("CVE-2026-2", { dueDate: "2026-11-21" }),
			row("CVE-2026-3", { knownRansomwareCampaignUse: "Known" }),
		],
	}) as [KevEntry, KevEntry, KevEntry];

	it("puts known ransomware use ahead of a nearer deadline", () => {
		expect(worst([plain, urgent, ransom])).toBe(ransom);
	});

	it("falls back to the earliest deadline", () => {
		expect(worst([plain, urgent])).toBe(urgent);
	});

	it("has no pick for an empty day", () => {
		expect(worst([])).toBeUndefined();
	});
});

describe("parseCatalog", () => {
	it("rejects a pull with a malformed row", () => {
		expect(() =>
			parseCatalog({ vulnerabilities: [row("CVE-2026-1", { dateAdded: "soon" })] }),
		).toThrow(/dateAdded/);

		expect(() => parseCatalog({})).toThrow(/vulnerabilities/);
	});
});

describe("ingestKev", () => {
	it("stores a pull, serves it by day, and sends the etag on the next check", async () => {
		const store = openStore(":memory:");
		const rows = [row("CVE-2026-1"), row("CVE-2026-2", { dateAdded: "2026-11-17" })];

		expect(await ingestKev(store, () => Promise.resolve(feed(rows)))).toBe("updated");

		expect(store.addedOn("2026-11-18").map((e) => e.cveId)).toEqual(["CVE-2026-1"]);
		expect(store.addedOn("2026-11-19")).toEqual([]);
		expect(store.latestDayBefore("2026-11-18")).toBe("2026-11-17");

		let sent: HeadersInit | undefined;
		const unchanged: typeof fetch = (_url, init) => {
			sent = init?.headers;

			return Promise.resolve(new Response(null, { status: 304 }));
		};

		expect(await ingestKev(store, unchanged)).toBe("unchanged");
		expect(sent).toEqual({ "If-None-Match": '"v1"' });
		expect(store.addedOn("2026-11-18")).toHaveLength(1);
	});

	it("keeps the stored copy when a pull fails or is malformed", async () => {
		const store = openStore(":memory:");

		await ingestKev(store, () => Promise.resolve(feed([row("CVE-2026-1")])));

		await expect(
			ingestKev(store, () => Promise.resolve(new Response("", { status: 503 }))),
		).rejects.toThrow(/503/);

		await expect(
			ingestKev(store, () => Promise.resolve(feed([row("CVE-2026-9", { dueDate: "" })]))),
		).rejects.toThrow(/dueDate/);

		expect(store.addedOn("2026-11-18").map((e) => e.cveId)).toEqual(["CVE-2026-1"]);
	});

	it("reflects a correction CISA makes to an entry", async () => {
		const store = openStore(":memory:");

		await ingestKev(store, () => Promise.resolve(feed([row("CVE-2026-1")])));

		await ingestKev(store, () =>
			Promise.resolve(feed([row("CVE-2026-1", { knownRansomwareCampaignUse: "Known" })], '"v2"')),
		);

		expect(store.addedOn("2026-11-18")[0]?.ransomware).toBe(true);
	});
});
