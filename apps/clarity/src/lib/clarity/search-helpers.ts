// Clarity search helpers — pure functions ported verbatim (behavior-preserving)
// from the vanilla app.ts: query syntax highlighting, recency-as-operator
// parsing, the safe client-side calculator, Numbat WASM bridge, host/escape,
// engine icons, file badges, and the result/video/image markup builders.
//
// These are framework-agnostic so they can be unit-reasoned and reused by the
// Svelte components without dragging in DOM/runes state.

export interface Result {
	url: string;
	title?: string;
	content?: string;
	engine?: string;
	engines?: string[];
	publishedDate?: string;
	thumbnail?: string;
	img_src?: string;
	resolution?: string;
	length?: string;
	duration?: string;
	author?: string;
}

export interface Entry {
	q: string;
	cat: string;
	priv: boolean;
	tr?: string;
	ms?: number;
	results: Result[];
	answers?: string[];
	page: number;
	exhausted?: boolean;
	n: number;
	loading?: boolean;
	numbat?: string;
	scroll?: number;
}

/* ---- SearXNG wire types (format=json) ---- */
export interface SearxResponse {
	error?: string;
	results?: Result[];
	answers?: (string | { answer?: string })[];
	number_of_results?: number;
}
export interface SearxConfig {
	engines?: { name: string; disabled?: boolean; categories?: string[] }[];
}

/** The slice of the settings store a search request depends on. */
export interface SearchPrefs {
	safeSearch: string;
	language: string;
	disabledEngines: string[];
}

export const urlFor = (q: string, cat: string, priv: boolean) => {
	const p = new URLSearchParams();

	p.set("q", q);

	if (cat && cat !== "general") p.set("categories", cat);

	if (priv) p.set("private", "1");

	return "/?" + p.toString();
};

/** Build the /search query string for one page (same-origin; traefik routes it to SearXNG). */
export function searchQueryString(
	q: string,
	cat: string,
	priv: boolean,
	page: number,
	cs: SearchPrefs,
): string {
	const { q: cleanQ, tr } = parseRecency(q);
	const p = new URLSearchParams({ q: cleanQ, format: "json", pageno: String(page) });

	if (priv) p.set("engines", PRIVATE_ENGINES);
	else p.set("categories", cat);

	if (tr) p.set("time_range", tr);

	p.set(
		"safesearch",
		({ off: "0", moderate: "1", strict: "2" } as Record<string, string>)[cs.safeSearch] ?? "1",
	);

	if (cs.language && cs.language !== "auto") p.set("language", cs.language);

	if (!priv && cs.disabledEngines?.length) p.set("disabled_engines", cs.disabledEngines.join(","));

	return p.toString();
}

export const esc = (s: unknown) =>
	String(s).replace(
		/[&<>"]/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]!,
	);

export const host = (u: string) => {
	try {
		return new URL(u).host.replace(/^www\./, "");
	} catch {
		return u;
	}
};

export const ENGINE_COLORS: Record<string, string> = {
	google: "#4285f4",
	bing: "#00897b",
	duckduckgo: "#de5833",
	brave: "#fb542b",
	mojeek: "#c4683b",
	marginalia: "#8a3a1f",
	startpage: "#2358b8",
	wikipedia: "#999999",
	qwant: "#5c97ff",
	mwmbl: "#e6a817",
};

export const PRIVATE_ENGINES = "duckduckgo,brave,startpage,mojeek,wikipedia,qwant";

/* ---- search-box syntax highlighting ---- */
const DORK_OPS =
	"site|filetype|ext|intitle|allintitle|inurl|allinurl|intext|inbody|before|after|past|lang|loc|near|cache|related|define|map|movie|weather|stocks";

export function highlightQuery(t: string) {
	let h = esc(t);

	h = h.replace(new RegExp("\\b(" + DORK_OPS + ")\\b:", "gi"), '<span class="hl-op">$1:</span>');
	h = h.replace(/(^|\s)(!{1,2}[a-z0-9_]+)/gi, '$1<span class="hl-bang">$2</span>');
	h = h.replace(/(^|\s)(-[^\s"&]+)/g, '$1<span class="hl-neg">$2</span>');
	h = h.replace(/(&quot;[^&]*?&quot;)/g, '<span class="hl-quote">$1</span>');

	return h;
}

/* ---- recency-as-operator: past:day|week|month|year (+ aliases) ---- */
const RECENCY: Record<string, string> = {
	day: "day",
	today: "day",
	"24h": "day",
	d: "day",
	week: "week",
	"7d": "week",
	w: "week",
	month: "month",
	"30d": "month",
	mo: "month",
	m: "month",
	year: "year",
	"12mo": "year",
	"365d": "year",
	y: "year",
};

export function parseRecency(raw: string) {
	let tr = "";
	const q = String(raw || "")
		.replace(/\bpast:([a-z0-9]+)\b/gi, (m: string, b: string) => {
			const hit = RECENCY[b.toLowerCase()];

			if (hit) {
				tr = hit;

				return "";
			}

			return m;
		})
		.replace(/\s{2,}/g, " ")
		.trim();

	return { q, tr };
}

export const TR_LABELS: Record<string, string> = {
	"": "Any time",
	day: "Past day",
	week: "Past week",
	month: "Past month",
	year: "Past year",
};

/* ---- safe client-side calculator (strict whitelist) ---- */
const CALC_FNS = [
	"sqrt",
	"cbrt",
	"sin",
	"cos",
	"tan",
	"asin",
	"acos",
	"atan",
	"abs",
	"round",
	"floor",
	"ceil",
	"exp",
	"sign",
	"log2",
	"log10",
	"min",
	"max",
];

export function calcAnswer(q: string): number | null {
	q = q
		.trim()
		.replace(/\s*=\s*$/, "")
		.trim();

	if (!/\d/.test(q)) return null;

	const probe = q
		.replace(new RegExp("\\b(" + CALC_FNS.join("|") + "|pi|tau|e)\\b", "gi"), "")
		.replace(/[\d+\-*/^%().,\s]/g, "");

	if (probe !== "") return null;

	if (!/[-+*/^%]|\b(sqrt|cbrt|sin|cos|tan|abs|round|floor|ceil|exp|min|max|log2|log10)\b/i.test(q))
		return null;

	const expr = q
		.replace(/\^/g, "**")
		.replace(/\bpi\b/gi, "(Math.PI)")
		.replace(/\btau\b/gi, "(2*Math.PI)")
		.replace(/\be\b/gi, "(Math.E)")
		.replace(
			new RegExp("\\b(" + CALC_FNS.join("|") + ")\\b", "gi"),
			(m) => "Math." + m.toLowerCase(),
		);

	try {
		const v = Function('"use strict";return (' + expr + ")")();

		if (typeof v === "number" && isFinite(v)) return +(+v).toPrecision(12);
	} catch {
		/* not a valid expression */
	}

	return null;
}

export function looksCalc(q: string) {
	if (!/[0-9]/.test(q) && !/\b(pi|tau)\b/i.test(q)) return false;

	if (/[-+*/^=]/.test(q)) return true;

	if (/\b(to|in|as)\b/i.test(q) && /\d\s*[a-zµ°$€£%]/i.test(q)) return true;

	if (/\b(sqrt|cbrt|sin|cos|tan|log|ln|exp|abs|floor|ceil|round|mod|gcd|lcm)\b/i.test(q))
		return true;

	if (/\d\s*%/.test(q)) return true;

	return false;
}

/* ---- Numbat WASM bridge (lazy dynamic import; same-origin /fx for rates) ---- */
interface Numbat {
	interpret(q: string): { is_error: boolean; output: string };
	set_exchange_rates(xml: string): void;
}
interface NumbatModule {
	default(opts: { module_or_path: string }): Promise<unknown>;
	// wasm-bindgen exposes a STATIC factory literally named `new` (not a JS constructor)
	Numbat: { ["new"](a: boolean, b: boolean, fmt: unknown): Numbat };
	FormatType: { Html: unknown };
}
let _numbatP: Promise<Numbat> | null = null;

export function loadNumbat() {
	if (!_numbatP)
		_numbatP = (async () => {
			// Runtime-only WASM module served as a static asset (static/numbat/pkg).
			// The path is built from a variable so Vite's import-analysis leaves it
			// alone (a literal string import would be eagerly resolved + fail dev).
			const numbatUrl = "/numbat/pkg/numbat_wasm.js";
			const mod = (await import(/* @vite-ignore */ numbatUrl)) as NumbatModule;

			await mod.default({ module_or_path: "/numbat/pkg/numbat_wasm_bg.wasm" });
			const nb = mod.Numbat.new(true, true, mod.FormatType.Html);

			try {
				const xml = await fetch("/fx").then((r) => (r.ok ? r.text() : null));

				if (xml) nb.set_exchange_rates(xml);
			} catch {
				/* rates optional */
			}

			return nb;
		})().catch((err) => {
			_numbatP = null;

			throw err;
		});

	return _numbatP;
}

const americanize = (s: string) => s.replace(/metre/g, "meter").replace(/litre/g, "liter");

export async function numbatAnswer(q: string): Promise<string | null> {
	try {
		const nb = await loadNumbat();
		const r = nb.interpret(q);

		if (r.is_error) return null;

		const out = r.output;

		return out?.trim() ? americanize(out) : null;
	} catch {
		return null;
	}
}

export function numbatCard(out: string) {
	const EQ = '<span class="numbat-operator">=</span>';
	const i = out.indexOf(EQ);
	let exp = i >= 0 ? out.slice(0, i) : "";
	let res = i >= 0 ? out.slice(i + EQ.length) : out;
	const dim = res.match(/<span class="numbat-type-identifier">([^<]+)<\/span>/);
	const tag = dim ? dim[1] : "";

	res = res.replace(/<span class="numbat-dimmed">[\s\S]*$/, "");

	const clean = (s: string) =>
		s
			.replace(/\s*\n\s*/g, " ")
			.replace(/\s+/g, " ")
			.trim();

	exp = clean(exp);
	res = clean(res);
	let meta = "powered by Numbat";

	if (exp.includes("➞")) {
		const vals = (s: string) =>
			[...s.matchAll(/<span class="numbat-value">([\d.eE+-]+)<\/span>/g)].map((m) =>
				parseFloat(m[1]!),
			);
		const units = (s: string) =>
			[...s.matchAll(/<span class="numbat-unit">([^<]+)<\/span>/g)].map((m) => m[1]);
		const A = vals(exp)[0],
			B = vals(res)[0],
			fu = units(exp)[0],
			tu = units(res)[0];

		if (A && B && fu && tu && isFinite(B / A))
			meta = `1 <span class="numbat-unit">${esc(fu)}</span> = ${+(B / A).toPrecision(6)} <span class="numbat-unit">${esc(tu)}</span> · powered by Numbat`;
	}

	return `<div class="r-answer calc numbat-card">${exp ? `<div class="nc-exp">${exp}</div>` : ""}<div class="nc-resrow"><span class="nc-res">${res}</span>${tag ? `<span class="nc-tag">${esc(tag)}</span>` : ""}</div><div class="nc-meta">${meta}</div></div>`;
}

/* ---- live-calc one-line formatting ---- */
function liveLine(html: string) {
	return html
		.replace(/<span class="numbat-dimmed">[\s\S]*$/, "")
		.replace(/\s*\n\s*/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function liveSplit(html: string) {
	const clean = liveLine(html);
	const op = '<span class="numbat-operator">=</span>';
	const i = clean.lastIndexOf(op);
	const left = i < 0 ? "" : clean.slice(0, i).trim();
	const right = i < 0 ? clean : clean.slice(i).trim();

	return `<span class="numbat-out lc-row">${left ? `<span class="lc-in">${left}</span>` : ""}<span class="lc-out">${right}</span></span>`;
}

/* ---- pure result-presentation helpers (the components render the markup) ---- */
const FT_MAP: Record<string, string> = {
	pdf: "pdf",
	doc: "doc",
	docx: "doc",
	rtf: "doc",
	xls: "xls",
	xlsx: "xls",
	csv: "xls",
	ppt: "ppt",
	pptx: "ppt",
	zip: "zip",
	rar: "zip",
	"7z": "zip",
	gz: "zip",
	tar: "zip",
};

/** File-type badge family + extension for a result URL (null = no badge). */
export const fileBadge = (url: string): { fam: string; ext: string } | null => {
	const m = /\.([a-z0-9]{1,4})(?:[?#].*)?$/i.exec(url || "");
	const ext = m?.[1]?.toLowerCase();
	const fam = ext && FT_MAP[ext];

	return fam && ext ? { fam, ext } : null;
};

/** Aspect ratio from a "WxH" resolution string, clamped 0.2–5.0 (default 1.5). */
export const aspectOf = (r: Result) => {
	const m = r.resolution && /(\d+)\s*[x×]\s*(\d+)/.exec(r.resolution);

	if (m) {
		const w = +m[1]!,
			h = +m[2]!;

		if (w > 0 && h > 0) return Math.max(0.2, Math.min(5.0, w / h));
	}

	return 1.5;
};
