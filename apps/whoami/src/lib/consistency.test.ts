import { describe, expect, it } from "vitest";

import { checkConsistency, verdictOf, type ClientView, type ServerSignals } from "./consistency";

const chrome =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

function server(overrides: Partial<ServerSignals> = {}): ServerSignals {
	return {
		userAgent: chrome,
		acceptLanguage: "en-US,en;q=0.9",
		acceptEncoding: null,
		accept: null,
		secChUa: '"Chromium";v="131"',
		secChUaPlatform: null,
		secChUaMobile: null,
		dnt: null,
		cfCountry: "US",
		cfRay: null,
		ip: null,
		...overrides,
	};
}

function client(overrides: Partial<ClientView> = {}): ClientView {
	return {
		userAgent: chrome,
		language: "en-US",
		languages: ["en-US", "en"],
		platform: "Win32",
		vendor: "Google Inc.",
		deviceMemory: 8,
		maxTouchPoints: 0,
		dpr: 1,
		timezone: "America/Chicago",
		utcOffsetMin: 360,
		...overrides,
	};
}

describe("checkConsistency", () => {
	it("leaves a coherent Chromium fingerprint alone", () => {
		expect(checkConsistency(server(), null, client())).toEqual([]);
	});

	it("reports independent spoofing contradictions with their expected severities", () => {
		const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
		const results = checkConsistency(
			server({ userAgent: firefox, secChUa: '"Chromium";v="131"', acceptLanguage: "fr-FR" }),
			{ warp: "off", gateway: null, loc: "JP", tls: null, colo: null, ip: null, rbi: null },
			client({
				userAgent: firefox,
				language: "en-US",
				platform: "Win32",
				vendor: "Google Inc.",
				deviceMemory: 8,
				timezone: "America/Chicago",
			}),
		);

		expect(results.map((result) => result.id)).toEqual([
			"ch.present-on-nonchromium",
			"devicememory.on-nonchromium",
			"vendor.google-on-firefox",
			"platform.vs-ua-os",
			"lang.header-vs-js",
			"tz.vs-ip-country",
		]);

		expect(results.find((result) => result.id === "ch.present-on-nonchromium")?.severity).toBe(
			"high",
		);
	});

	it("does not use Cloudflare WARP's exit country for a timezone mismatch", () => {
		const results = checkConsistency(
			server({ cfCountry: "JP" }),
			{ warp: "plus", gateway: null, loc: "JP", tls: null, colo: null, ip: null, rbi: null },
			client(),
		);

		expect(results.map((result) => result.id)).not.toContain("tz.vs-ip-country");
	});
});

describe("verdictOf", () => {
	it("prioritizes high-severity contradictions over lower-severity findings", () => {
		expect(verdictOf([])).toBe("coherent");

		expect(verdictOf([{ severity: "medium" } as ReturnType<typeof checkConsistency>[number]])).toBe(
			"minor",
		);

		expect(
			verdictOf([
				{ severity: "medium" } as ReturnType<typeof checkConsistency>[number],
				{ severity: "high" } as ReturnType<typeof checkConsistency>[number],
			]),
		).toBe("contradictions");
	});
});
