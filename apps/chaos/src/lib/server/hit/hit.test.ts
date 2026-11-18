import { describe, expect, it } from "vitest";

import type { KevEntry } from "../kev";
import { board } from "../status/board";
import { openStore, type Store } from "../store";
import { hitCheck } from "./check";
import type { Dns } from "./lookup";

const NOW = new Date("2026-11-18T17:00:00Z");
const TODAY = "2026-11-18";

interface Records {
	ns: string[];
	mx: string[];
	txt: string[];
	cname: string[];
}

const NONE: Records = { ns: [], mx: [], txt: [], cname: [] };
const refusal = (code: string) => Object.assign(new Error(code), { code });

/** A resolver that answers from fixed records, as the system resolver would: no records is ENODATA. */
function resolver(records: Records | "missing" | "failed", asked: string[] = []): Dns {
	const answer = <T>(name: string, pick: (found: Records) => T[]): Promise<T[]> => {
		asked.push(name);

		if (records === "missing" || records === "failed") {
			return Promise.reject(refusal(records === "missing" ? "ENOTFOUND" : "ETIMEOUT"));
		}

		const found = pick(records);

		return found.length > 0 ? Promise.resolve(found) : Promise.reject(refusal("ENODATA"));
	};

	return {
		resolveNs: (name) => answer(name, (found) => found.ns),
		resolveMx: (name) => answer(name, (found) => found.mx.map((exchange) => ({ exchange }))),
		resolveTxt: (name) => answer(name, (found) => found.txt.map((record) => [record])),
		resolveCname: (name) => answer(name, (found) => found.cname),
	};
}

const entry = (cveId: string, vendor: string, dateAdded: string, ransomware = false): KevEntry => ({
	cveId,
	vendor,
	product: "Product",
	name: `${vendor} flaw ${cveId}`,
	description: "",
	dateAdded,
	dueDate: "2026-12-09",
	ransomware,
});

let minute = 0;

/**
 * Runs the check with a stand-in for DNS, and records every name it was asked for. `prepare` fills
 * the store as of the moment of the check. Each call takes its own minute, so the rate limit never
 * touches these checks.
 */
async function check(
	input: string | null,
	records: Records | "missing" | "failed" = NONE,
	prepare: (store: Store, now: Date) => void = () => undefined,
) {
	const asked: string[] = [];
	const dns = resolver(records, asked);

	const store = openStore(":memory:");

	minute += 1;

	const now = new Date(NOW.getTime() + minute * 61_000);

	prepare(store, now);

	const result = await hitCheck(store, board(store, now).rows, input, TODAY, now, dns);

	// The apex name three times and "www" once: nothing else is ever asked.
	return { result, asked: [...new Set(asked.map((name) => name.replace(/^www\./, "")))] };
}

describe("what a visitor may type", () => {
	it("does nothing until a domain is typed", async () => {
		expect(await check(null)).toEqual({ result: { kind: "idle" }, asked: [] });
		expect((await check("  ")).result).toEqual({ kind: "idle" });
	});

	it("cuts a pasted address or URL down to its domain", async () => {
		const typed = [
			"Example.org",
			" https://www.example.org/path?q=1 ",
			"someone@example.org",
			"example.org.",
		];
		const checks = await Promise.all(typed.map((input) => check(input)));

		expect(checks.map((done) => done.asked)).toEqual(typed.map(() => ["example.org"]));
	});

	it("refuses anything that is not a public domain name, without a lookup", async () => {
		const refused = [
			"localhost",
			"10.10.10.14",
			"http://127.0.0.1:4466/",
			"[::1]",
			"printer.local",
			"nas.lan",
			"host.internal",
			"14.10.10.10.in-addr.arpa",
			"example",
			"exa mple.org",
			"-bad.org",
			`${"a".repeat(64)}.org`,
			"example.org; rm -rf /",
			"<script>alert(1)</script>.org",
		];

		const checks = await Promise.all(refused.map((input) => check(input)));

		expect(checks).toEqual(refused.map(() => ({ result: { kind: "invalid" }, asked: [] })));
	});

	it("says when the domain does not exist or the lookup failed, and assumes nothing", async () => {
		expect((await check("example.org", "missing")).result).toEqual({
			kind: "missing",
			domain: "example.org",
		});

		expect((await check("example.org", "failed")).result).toEqual({
			kind: "failed",
			domain: "example.org",
		});
	});
});

describe("reading the records", () => {
	const RECORDS: Records = {
		ns: ["sid.ns.cloudflare.com", "brynne.ns.cloudflare.com"],
		mx: ["example-org.mail.protection.outlook.com"],
		txt: [
			"v=spf1 include:spf.protection.outlook.com include:sendgrid.net ~all",
			"atlassian-domain-verification=SECRETTOKEN",
			"MS=ms12345678",
			"unrelated=value",
		],
		cname: ["cname.vercel-dns.com"],
	};

	it("names each provider with the record that shows it, and never prints a proof token", async () => {
		const { result } = await check("example.org", RECORDS);

		expect(result).toMatchObject({ kind: "result", domain: "example.org" });

		const findings = result.kind === "result" ? result.findings : [];

		expect(Object.fromEntries(findings.map((finding) => [finding.name, finding.signs]))).toEqual({
			Cloudflare: [{ role: "DNS", evidence: "NS sid.ns.cloudflare.com" }],
			Microsoft: [
				{ role: "Mail", evidence: "MX example-org.mail.protection.outlook.com" },
				{ role: "Sends mail", evidence: "SPF include spf.protection.outlook.com" },
				{ role: "Account", evidence: "TXT MS" },
			],
			Vercel: [{ role: "Website", evidence: "www CNAME cname.vercel-dns.com" }],
			Atlassian: [{ role: "Account", evidence: "TXT atlassian-domain-verification" }],
			"Twilio SendGrid": [{ role: "Sends mail", evidence: "SPF include sendgrid.net" }],
		});

		expect(JSON.stringify(result)).not.toContain("SECRETTOKEN");
	});

	it("matches a provider on a whole host suffix, never on a look-alike name", async () => {
		const { result } = await check("example.org", {
			ns: ["ns1.notcloudflare.com.evil.example"],
			mx: ["mail.google.com.attacker.example"],
			txt: ["xMS=1", "MS=unrelated", "v=spf1 include:sendgrid.net.evil.example ~all"],
			cname: ["vercel-dns.com.evil.example"],
		});

		expect(result).toMatchObject({ kind: "result", findings: [] });
	});

	it("reports no provider when the records name none", async () => {
		expect((await check("example.org", NONE)).result).toMatchObject({
			kind: "result",
			findings: [],
		});
	});
});

describe("what the resolver says", () => {
	const only = (answers: Partial<Record<keyof Dns, string>>, records: Records = NONE): Dns => {
		const base = resolver(records);
		const or = <A extends unknown[], T>(key: keyof Dns, ask: (...args: A) => Promise<T>) =>
			answers[key] === undefined ? ask : () => Promise.reject(refusal(answers[key] ?? ""));

		return {
			resolveNs: or("resolveNs", base.resolveNs),
			resolveMx: or("resolveMx", base.resolveMx),
			resolveTxt: or("resolveTxt", base.resolveTxt),
			resolveCname: or("resolveCname", base.resolveCname),
		};
	};

	const through = (dns: Dns, at: number) =>
		hitCheck(
			openStore(":memory:"),
			[],
			"app.example.org",
			TODAY,
			new Date(Date.UTC(2028, 0, 1, 0, at)),
			dns,
		);

	it("does not call a name missing because it has no www or none of these records", async () => {
		// A host with only an address record: every answer is empty, and "www" under it does not exist.
		expect(await through(only({ resolveCname: "ENOTFOUND" }), 1)).toMatchObject({
			kind: "result",
			findings: [],
		});

		expect(
			await through(
				only({ resolveCname: "ENOTFOUND" }, { ...NONE, ns: ["sid.ns.cloudflare.com"] }),
				2,
			),
		).toMatchObject({ kind: "result", findings: [{ name: "Cloudflare" }] });
	});

	it("calls a name missing only when the resolver says the name itself does not exist", async () => {
		const gone = {
			resolveNs: "ENOTFOUND",
			resolveMx: "ENOTFOUND",
			resolveTxt: "ENOTFOUND",
			resolveCname: "ENOTFOUND",
		};

		expect(await through(only(gone), 3)).toEqual({ kind: "missing", domain: "app.example.org" });

		// A resolver that is slow to refuse "www" under a missing name changes nothing.
		expect(await through(only({ ...gone, resolveCname: "ETIMEOUT" }), 7)).toMatchObject({
			kind: "missing",
		});
	});

	it("gives no answer when any question fails, whatever the others said", async () => {
		const records = { ...NONE, ns: ["sid.ns.cloudflare.com"] };

		expect(await through(only({ resolveTxt: "ESERVFAIL" }, records), 4)).toEqual({
			kind: "failed",
			domain: "app.example.org",
		});

		expect(
			await through(
				{ ...resolver(records), resolveMx: () => Promise.reject(new Error("boom")) },
				5,
			),
		).toMatchObject({
			kind: "failed",
		});
	});

	it("reads an SPF include whatever its qualifier or case", async () => {
		const spf = {
			...NONE,
			txt: ["V=SPF1 ~include:sendgrid.net ?INCLUDE:_spf.salesforce.com -all"],
		};
		const result = await through(resolver(spf), 6);

		expect(result.kind === "result" ? result.findings.map((finding) => finding.name) : []).toEqual([
			"Twilio SendGrid",
			"Salesforce",
		]);
	});
});

describe("setting a provider against the panel", () => {
	const MICROSOFT: Records = { ...NONE, mx: ["example-org.mail.protection.outlook.com"] };
	const listed =
		(entries: KevEntry[], also: (store: Store, now: Date) => void = () => undefined) =>
		(store: Store, now: Date) => {
			store.save(entries, null, now);
			also(store, now);
		};
	const says =
		(service: string, level: "ok" | "degraded", text: string) => (store: Store, now: Date) => {
			store.saveClaim(service, { level, text }, now);
			store.saveProbe(service, true, "120 ms", now);
		};

	it("counts the vendor's exploited vulnerabilities of the last 30 days and names the worst", async () => {
		const store = listed([
			entry("CVE-2026-1", "Microsoft", "2026-11-17"),
			entry("CVE-2026-2", "Microsoft", "2026-10-20", true),
			entry("CVE-2026-3", "Microsoft", "2026-10-19"),
			entry("CVE-2026-4", "Cisco", "2026-11-17"),
			entry("CVE-2026-5", "Fake Microsoft Corp", "2026-11-17"),
		]);
		const { result } = await check("example.org", MICROSOFT, store);

		expect(result).toMatchObject({
			findings: [
				{
					name: "Microsoft",
					hit: true,
					exploited: { count: 2, worst: { cveId: "CVE-2026-2", dateAdded: "2026-10-20" } },
				},
			],
		});
	});

	it("is clear when the vendor has nothing recent and its status page reports no trouble", async () => {
		const store = listed(
			[entry("CVE-2026-3", "Microsoft", "2026-10-19")],
			says("azure", "ok", "No open events"),
		);

		expect((await check("example.org", MICROSOFT, store)).result).toMatchObject({
			findings: [
				{
					hit: false,
					exploited: { count: 0, worst: undefined },
					status: { verdict: "agree", claim: { text: "No open events" } },
				},
			],
		});
	});

	it("hits when the provider's own status page reports trouble, and lists hits first", async () => {
		const store = listed([entry("CVE-2026-3", "Microsoft", "2026-10-19")], (inner, now) => {
			says("cloudflare", "degraded", "Partially Degraded Service")(inner, now);
			says("azure", "ok", "No open events")(inner, now);
		});
		const { result } = await check(
			"example.org",
			{ ...MICROSOFT, ns: ["sid.ns.cloudflare.com"] },
			store,
		);

		expect(result).toMatchObject({
			findings: [
				{
					name: "Cloudflare",
					hit: true,
					status: { claim: { text: "Partially Degraded Service" } },
				},
				{ name: "Microsoft", hit: false, tracked: true },
			],
		});
	});

	it("calls a provider it has no reading for not tracked, never clear", async () => {
		const { result } = await check("example.org", {
			...NONE,
			txt: ["stripe-verification=abc", "slack-domain-verification=abc", "MS=ms1"],
		});

		expect(
			result.kind === "result"
				? result.findings.map((finding) => [finding.name, finding.tracked, finding.hit])
				: [],
		).toEqual([
			// Microsoft is on CISA's list by name. Slack's status row has no reading, and Stripe has neither.
			["Microsoft", true, false],
			["Slack", false, false],
			["Stripe", false, false],
		]);
	});

	it("names AWS and Azure name servers by their numbered hosts only", async () => {
		const { result } = await check("example.org", {
			...NONE,
			ns: ["ns-520.awsdns-01.net", "ns1-05.azure-dns.com", "ns1.awsdns-fake.example"],
		});

		expect(result.kind === "result" ? result.findings.map((finding) => finding.signs) : []).toEqual(
			[
				[{ role: "DNS", evidence: "NS ns-520.awsdns-01.net" }],
				[{ role: "DNS", evidence: "NS ns1-05.azure-dns.com" }],
			],
		);
	});
});

it("stops after 20 checks in a minute and recovers in the next one", async () => {
	const store = openStore(":memory:");
	const at = new Date("2027-01-01T00:00:00Z");
	const run = (now: Date) => hitCheck(store, [], "example.org", TODAY, now, resolver(NONE));
	const kinds = (await Promise.all(Array.from({ length: 21 }, () => run(at)))).map(
		(done) => done.kind,
	);

	expect(kinds.slice(0, 20).every((kind) => kind === "result")).toBe(true);
	expect(kinds[20]).toBe("busy");
	expect((await run(new Date(at.getTime() + 61_000))).kind).toBe("result");
});
