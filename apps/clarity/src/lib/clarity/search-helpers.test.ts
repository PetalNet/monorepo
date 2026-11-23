import { describe, expect, it } from "vitest";

import {
	aspectOf,
	calcAnswer,
	esc,
	fileBadge,
	highlightQuery,
	host,
	liveSplit,
	looksCalc,
	numbatCard,
	parseRecency,
	searchQueryString,
	urlFor,
} from "./search-helpers";

describe("esc", () => {
	it("escapes the four HTML-sensitive characters", () => {
		expect(esc('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
	});
});

describe("host", () => {
	it("strips www and returns the host", () => {
		expect(host("https://www.example.com/path?q=1")).toBe("example.com");
	});

	it("returns the input when not a URL", () => {
		expect(host("not a url")).toBe("not a url");
	});
});

describe("parseRecency", () => {
	it("extracts past:week and strips it from the query", () => {
		expect(parseRecency("rust news past:week")).toEqual({ q: "rust news", tr: "week" });
	});

	it.each([
		["past:today", "day"],
		["past:24h", "day"],
		["past:d", "day"],
		["past:7d", "week"],
		["past:w", "week"],
		["past:30d", "month"],
		["past:mo", "month"],
		["past:m", "month"],
		["past:12mo", "year"],
		["past:365d", "year"],
		["past:y", "year"],
	])("maps alias %s → %s", (op, tr) => {
		expect(parseRecency(`x ${op}`).tr).toBe(tr);
	});

	it("leaves an unknown past: operator literal", () => {
		expect(parseRecency("cake past:fortnight")).toEqual({ q: "cake past:fortnight", tr: "" });
	});

	it("collapses the double space left by stripping", () => {
		expect(parseRecency("a past:day b").q).toBe("a b");
	});
});

describe("calcAnswer", () => {
	it("evaluates plain arithmetic", () => {
		expect(calcAnswer("2 + 2 * 3")).toBe(8);
	});

	it("supports ^ as power and constants", () => {
		expect(calcAnswer("2^10")).toBe(1024);
		expect(calcAnswer("pi * 2")).toBeCloseTo(Math.PI * 2, 10);
	});

	it("supports whitelisted functions", () => {
		expect(calcAnswer("sqrt(16) + max(1, 2)")).toBe(6);
	});

	it("tolerates a trailing =", () => {
		expect(calcAnswer("40 + 2 =")).toBe(42);
	});

	it("rejects anything with a non-whitelisted residue (no eval of code)", () => {
		expect(calcAnswer("alert(1)")).toBeNull();
		expect(calcAnswer("2+2; alert(1)")).toBeNull();
		expect(calcAnswer("window.location=1")).toBeNull();
		expect(calcAnswer("constructor")).toBeNull();
	});

	it("rejects plain numbers and text", () => {
		expect(calcAnswer("42")).toBeNull();
		expect(calcAnswer("the answer")).toBeNull();
	});
});

describe("looksCalc", () => {
	it("spots operators next to digits", () => {
		expect(looksCalc("3 * 7")).toBe(true);
	});

	it("spots unit conversions", () => {
		expect(looksCalc("3 km to miles")).toBe(true);
	});

	it("spots math function names", () => {
		expect(looksCalc("sqrt 2")).toBe(true);
	});

	it("spots percentages", () => {
		expect(looksCalc("15 % of 80")).toBe(true);
	});

	it("rejects plain queries", () => {
		expect(looksCalc("weather in berlin")).toBe(false);
	});
});

describe("highlightQuery", () => {
	it("marks operators, bangs, negations and quotes", () => {
		const h = highlightQuery('site:x.com !g -bad "exact"');

		expect(h).toContain('<span class="hl-op">site:</span>');
		expect(h).toContain('<span class="hl-bang">!g</span>');
		expect(h).toContain('<span class="hl-neg">-bad</span>');
		expect(h).toContain('<span class="hl-quote">&quot;exact&quot;</span>');
	});

	it("escapes HTML before marking (no injection through the overlay)", () => {
		expect(highlightQuery("<img onerror=x>")).not.toContain("<img");
	});
});

describe("fileBadge", () => {
	it("maps known extensions to families", () => {
		expect(fileBadge("https://x.com/a.pdf")).toEqual({ fam: "pdf", ext: "pdf" });
		expect(fileBadge("https://x.com/a.docx?dl=1")).toEqual({ fam: "doc", ext: "docx" });
		expect(fileBadge("https://x.com/a.7z")).toEqual({ fam: "zip", ext: "7z" });
	});

	it("returns null for unbadged URLs", () => {
		expect(fileBadge("https://x.com/page.html")).toBeNull();
		expect(fileBadge("https://x.com/")).toBeNull();
	});
});

describe("aspectOf", () => {
	it("parses WxH and clamps to 0.2–5.0", () => {
		expect(aspectOf({ url: "", resolution: "300x200" })).toBe(1.5);
		expect(aspectOf({ url: "", resolution: "10000x100" })).toBe(5.0);
		expect(aspectOf({ url: "", resolution: "100x10000" })).toBe(0.2);
	});

	it("defaults to 1.5 without a resolution", () => {
		expect(aspectOf({ url: "" })).toBe(1.5);
	});
});

describe("urlFor", () => {
	it("builds the canonical key URL", () => {
		expect(urlFor("a b", "general", false)).toBe("/?q=a+b");
		expect(urlFor("a", "images", false)).toBe("/?q=a&categories=images");
		expect(urlFor("a", "general", true)).toBe("/?q=a&private=1");
	});
});

describe("searchQueryString", () => {
	const cs = { safeSearch: "moderate", language: "auto", disabledEngines: [] };

	it("sends categories + parsed recency + safesearch", () => {
		const p = new URLSearchParams(searchQueryString("x past:week", "general", false, 2, cs));

		expect(p.get("q")).toBe("x");
		expect(p.get("time_range")).toBe("week");
		expect(p.get("pageno")).toBe("2");
		expect(p.get("categories")).toBe("general");
		expect(p.get("safesearch")).toBe("1");
		expect(p.get("language")).toBeNull();
	});

	it("private search sends the fixed engine list instead of categories", () => {
		const p = new URLSearchParams(searchQueryString("x", "general", true, 1, cs));

		expect(p.get("engines")).toBe("duckduckgo,brave,startpage,mojeek,wikipedia,qwant");
		expect(p.get("categories")).toBeNull();
	});

	it("maps safeSearch off/strict and sends language + disabled_engines", () => {
		const p = new URLSearchParams(
			searchQueryString("x", "images", false, 1, {
				safeSearch: "strict",
				language: "de",
				disabledEngines: ["a", "b"],
			}),
		);

		expect(p.get("safesearch")).toBe("2");
		expect(p.get("language")).toBe("de");
		expect(p.get("disabled_engines")).toBe("a,b");
	});

	it("never sends disabled_engines on private searches", () => {
		const p = new URLSearchParams(
			searchQueryString("x", "general", true, 1, { ...cs, disabledEngines: ["a"] }),
		);

		expect(p.get("disabled_engines")).toBeNull();
	});
});

describe("numbatCard / liveSplit", () => {
	const NUMBAT_OUT =
		'<span class="numbat-value">3</span> <span class="numbat-unit">km</span> ➞ ' +
		'<span class="numbat-operator">=</span> <span class="numbat-value">1.86411</span> ' +
		'<span class="numbat-unit">mi</span> <span class="numbat-type-identifier">Length</span>';

	it("splits expression/result and lifts the dimension tag", () => {
		const html = numbatCard(NUMBAT_OUT);

		expect(html).toContain("nc-exp");
		expect(html).toContain("nc-res");
		expect(html).toContain('<span class="nc-tag">Length</span>');
	});

	it("computes the per-unit ratio meta for ➞ conversions", () => {
		const html = numbatCard(NUMBAT_OUT);

		expect(html).toContain('1 <span class="numbat-unit">km</span> = 0.62137');
		expect(html).toContain("powered by Numbat");
	});

	it("liveSplit dims the input left of the last =", () => {
		const html = liveSplit(
			'2 + 2 <span class="numbat-operator">=</span> <span class="numbat-value">4</span>',
		);

		expect(html).toContain("lc-in");
		expect(html).toContain("lc-out");
	});
});
