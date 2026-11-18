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

const MODIFIED = "Tue, 17 Nov 2026 17:53:15 GMT";

/** Answers like CISA's server: an empty 304 only when If-Modified-Since matches. */
const cisa =
	(rows: unknown[], modified: string | null = MODIFIED): typeof fetch =>
	(_url, init) => {
		const since = new Headers(init?.headers).get("if-modified-since");

		return Promise.resolve(
			modified !== null && since === modified
				? new Response(null, { status: 304 })
				: Response.json(
						{ vulnerabilities: rows },
						{ headers: modified === null ? {} : { "last-modified": modified } },
					),
		);
	};

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
	it("stores a pull by day and gets an empty answer while the feed is unchanged", async () => {
		const store = openStore(":memory:");
		const server = cisa([row("CVE-2026-1"), row("CVE-2026-2", { dateAdded: "2026-11-17" })]);

		expect(await ingestKev(store, server)).toBe("updated");
		expect(store.addedOn("2026-11-18").map((e) => e.cveId)).toEqual(["CVE-2026-1"]);
		expect(store.addedOn("2026-11-19")).toEqual([]);
		expect(store.latestDayBefore("2026-11-18")).toBe("2026-11-17");

		const later = new Date("2026-11-18T20:00:00Z");

		expect(await ingestKev(store, server, later)).toBe("unchanged");
		expect(store.checkedAt()).toBe(later.toISOString());
		expect(store.addedOn("2026-11-18")).toHaveLength(1);
	});

	it("pulls the body again once the feed changes or stops sending Last-Modified", async () => {
		const store = openStore(":memory:");

		await ingestKev(store, cisa([row("CVE-2026-1")]));
		expect(await ingestKev(store, cisa([row("CVE-2026-1")], null))).toBe("updated");
		expect(await ingestKev(store, cisa([row("CVE-2026-1")]))).toBe("updated");
	});

	it("keeps the stored copy when a pull fails or is malformed", async () => {
		const store = openStore(":memory:");

		await ingestKev(store, cisa([row("CVE-2026-1")]));

		await expect(
			ingestKev(store, () => Promise.resolve(new Response("", { status: 503 }))),
		).rejects.toThrow(/503/);

		await expect(
			ingestKev(store, cisa([row("CVE-2026-9", { dueDate: "" })], "newer")),
		).rejects.toThrow(/dueDate/);

		expect(store.addedOn("2026-11-18").map((e) => e.cveId)).toEqual(["CVE-2026-1"]);
	});

	it("follows CISA when it corrects or removes an entry", async () => {
		const store = openStore(":memory:");

		await ingestKev(store, cisa([row("CVE-2026-1"), row("CVE-2026-2")]));

		await ingestKev(
			store,
			cisa([row("CVE-2026-1", { knownRansomwareCampaignUse: "Known" })], "newer"),
		);

		expect(store.addedOn("2026-11-18")).toMatchObject([{ cveId: "CVE-2026-1", ransomware: true }]);
	});
});
