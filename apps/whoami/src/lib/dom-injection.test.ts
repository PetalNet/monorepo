// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"enableJavaScriptEvaluation": true}}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import appHtml from "../app.html?raw";
import { INDICATORS, watchDomInjection, type DomFinding, type DomWatch } from "./dom-injection";

// One fixture per selector in the table, each doing what the extension does to a page.
// Iframes get an empty srcdoc so happy-dom doesn't try to load them.
interface Fixture {
	indicator: string;
	evidence: string;
	inject: () => void;
}

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
	const node = document.createElement(tag);

	for (const [k, v] of Object.entries(attrs)) {
		node.setAttribute(k, v);
	}

	return node;
}

/** What an extension does to an element that's already in the page. */
function stamp(target: Element, name: string, value = ""): void {
	target.setAttribute(name, value);
}

function input(): HTMLInputElement {
	const field = document.querySelector("input");

	if (!field) {
		throw new Error("fixture page has no <input>");
	}

	return field;
}

const FIXTURES: Fixture[] = [
	{
		indicator: "grammarly",
		evidence: "grammarly-desktop-integration",
		inject: () => {
			document.body.append(
				el("grammarly-desktop-integration", { "data-grammarly-shadow-root": "true" }),
			);
		},
	},
	{
		indicator: "grammarly",
		evidence: "grammarly-extension",
		inject: () => {
			const host = el("grammarly-extension");

			host.attachShadow({ mode: "closed" });
			document.body.append(host);
		},
	},
	{
		indicator: "grammarly",
		evidence: "grammarly-popups",
		inject: () => {
			document.body.append(el("grammarly-popups"));
		},
	},
	{
		indicator: "grammarly",
		evidence: "[data-grammarly-shadow-root]",
		inject: () => {
			document.body.append(el("div", { "data-grammarly-shadow-root": "true" }));
		},
	},
	{
		indicator: "grammarly",
		evidence: "[data-gr-ext-installed]",
		inject: () => {
			stamp(document.body, "data-gr-ext-installed", "");
		},
	},
	{
		indicator: "grammarly",
		evidence: "[data-new-gr-c-s-check-loaded]",
		inject: () => {
			stamp(document.body, "data-new-gr-c-s-check-loaded", "14.1250.0");
		},
	},
	{
		indicator: "1password",
		evidence: "com-1password-button",
		inject: () => {
			document.body.append(el("com-1password-button"));
		},
	},
	{
		indicator: "1password",
		evidence: "com-1password-menu",
		inject: () => {
			document.body.append(el("com-1password-menu"));
		},
	},
	{
		indicator: "1password",
		evidence: "[data-com-onepassword-filled]",
		inject: () => {
			stamp(input(), "data-com-onepassword-filled", "light");
		},
	},
	{
		indicator: "bitwarden",
		evidence: "bit-notification-bar-root",
		inject: () => {
			const root = el("bit-notification-bar-root");

			root.attachShadow({ mode: "closed" }).append(el("div", { id: "bit-notification-bar" }));
			document.body.append(root);
		},
	},
	{
		indicator: "bitwarden",
		evidence: "#bit-notification-bar",
		inject: () => {
			document.body.append(el("div", { id: "bit-notification-bar" }));
		},
	},
	{
		// Older builds put the bar's iframe straight into the page.
		indicator: "bitwarden",
		evidence: "#bit-notification-bar-iframe",
		inject: () => {
			document.body.append(el("iframe", { id: "bit-notification-bar-iframe", srcdoc: "" }));
		},
	},
	{
		indicator: "lastpass",
		evidence: "[data-lastpass-icon-root]",
		inject: () => {
			input().after(el("div", { "data-lastpass-icon-root": "" }));
		},
	},
	{
		indicator: "lastpass",
		evidence: "[data-lastpass-root]",
		inject: () => {
			document.body.append(el("div", { "data-lastpass-root": "" }));
		},
	},
	{
		indicator: "dashlane",
		evidence: "[data-dashlane-rid]",
		inject: () => {
			stamp(input(), "data-dashlane-rid", "8c1f2a");
		},
	},
	{
		indicator: "dashlane",
		evidence: "[data-dashlane-classification]",
		inject: () => {
			stamp(input(), "data-dashlane-classification", "username");
		},
	},
	{
		indicator: "dashlane",
		evidence: "[data-kwimpalastatus]",
		inject: () => {
			stamp(input(), "data-kwimpalastatus", "alive");
		},
	},
	{
		// The tag name carries a per-install hash; the role attribute doesn't.
		indicator: "proton-pass",
		evidence: "[data-protonpass-role]",
		inject: () => {
			document.body.append(el("protonpass-root-3f9a1c", { "data-protonpass-role": "root" }));
		},
	},
	{
		indicator: "dark-reader",
		evidence: "html[data-darkreader-mode]",
		inject: () => {
			stamp(document.documentElement, "data-darkreader-mode", "dynamic");
		},
	},
	{
		indicator: "dark-reader",
		evidence: "html[data-darkreader-scheme]",
		inject: () => {
			stamp(document.documentElement, "data-darkreader-scheme", "dark");
		},
	},
	{
		indicator: "dark-reader",
		evidence: 'meta[name="darkreader"]',
		inject: () => {
			document.head.append(el("meta", { name: "darkreader", content: "a1b2" }));
		},
	},
	{
		indicator: "dark-reader",
		evidence: "style.darkreader",
		inject: () => {
			document.head.append(el("style", { class: "darkreader darkreader--fallback" }));
		},
	},
	{
		indicator: "dark-reader",
		evidence: "[data-darkreader-inline-bgcolor]",
		inject: () => {
			stamp(document.body, "data-darkreader-inline-bgcolor", "");
		},
	},
	{
		indicator: "dark-reader",
		evidence: "[data-darkreader-inline-color]",
		inject: () => {
			stamp(input(), "data-darkreader-inline-color", "");
		},
	},
	{
		indicator: "google-translate",
		evidence: "html.translated-ltr",
		inject: () => {
			document.documentElement.classList.add("translated-ltr");
		},
	},
	{
		indicator: "google-translate",
		evidence: "html.translated-rtl",
		inject: () => {
			document.documentElement.classList.add("translated-rtl");
		},
	},
	{
		indicator: "google-translate",
		evidence: "#goog-gt-tt",
		inject: () => {
			document.body.append(el("div", { id: "goog-gt-tt", class: "skiptranslate" }));
		},
	},
	{
		indicator: "google-translate",
		evidence: ".goog-te-banner-frame",
		inject: () => {
			document.body.append(
				el("iframe", { class: "goog-te-banner-frame skiptranslate", srcdoc: "" }),
			);
		},
	},
	{
		indicator: "page-translation",
		evidence: 'html[lang] rewritten "en" → "fr"',
		inject: () => {
			stamp(document.documentElement, "lang", "fr");
		},
	},
	{
		indicator: "video-speed-controller",
		evidence: "vsc-controller",
		inject: () => {
			document.body.append(el("vsc-controller"));
		},
	},
];

// Controlled clock: the bootstrap and the module both read performance.now().
let clock = 0;
let watch: DomWatch | null = null;

function resetPage() {
	const html = document.documentElement;

	for (const name of html.getAttributeNames()) {
		html.removeAttribute(name);
	}

	html.setAttribute("lang", "en");
	html.innerHTML = '<head><title>whoami</title></head><body><main><input name="q" /></main></body>';
}

function flush(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function start(): { latest: () => DomFinding[] } {
	let last: DomFinding[] = [];

	watch = watchDomInjection((f) => {
		last = f;
	});

	return { latest: () => last };
}

function bootstrapFromAppHtml() {
	const script = /<script>([\s\S]*?)<\/script>/.exec(appHtml)?.[1];

	if (!script) {
		throw new Error("app.html has no inline bootstrap <script>");
	}

	// Run it the way the browser does: as an inline <script> in <head>.
	const tag = document.createElement("script");

	tag.textContent = script;
	document.head.prepend(tag);
}

beforeEach(() => {
	clock = 0;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	resetPage();
});

afterEach(() => {
	watch?.stop();
	watch = null;
	window.whoamiDomWatch?.o.disconnect();
	delete window.whoamiDomWatch;
	vi.restoreAllMocks();
});

describe("indicator table", () => {
	it.each(FIXTURES)("names $indicator from $evidence", async ({ indicator, evidence, inject }) => {
		const { latest } = start();

		clock = 250;
		inject();
		await flush();

		const finding = latest().find((f) => f.id === indicator);

		expect(finding?.evidence).toContain(evidence);
		expect(finding?.firstSeenMs).toBe(250);
		expect(finding?.preexisting).toBe(false);
		// One injection names one extension.
		expect(latest().map((f) => f.id)).toEqual([indicator]);
	});

	it("has a fixture for every selector, so no entry is untested", () => {
		const covered = new Set(FIXTURES.map((f) => `${f.indicator} ${f.evidence}`));
		const missing = INDICATORS.flatMap((i) =>
			i.selectors.map((s) => `${i.id} ${s}`).filter((key) => !covered.has(key)),
		);

		expect(missing).toEqual([]);
		expect(FIXTURES.some((f) => f.indicator === "page-translation")).toBe(true);
	});

	it("stays silent for a page's own DOM churn and opt-out attributes", async () => {
		const { latest } = start();

		clock = 100;
		document.body.append(el("div", { class: "row sel", "data-id": "canvas.digest" }));
		document.head.append(el("style", { "data-svelte-h": "x" }));
		stamp(document.body, "data-sveltekit-preload-data", "hover");
		// Opt-outs a page writes to keep password managers away: not an extension.
		stamp(input(), "data-1p-ignore", "");
		stamp(input(), "data-lpignore", "true");
		stamp(input(), "data-bwignore", "");
		// Re-setting lang to its own value is not a rewrite.
		stamp(document.documentElement, "lang", "en");
		await flush();

		expect(latest()).toEqual([]);
	});
});

describe("early observer from app.html", () => {
	it("credits each injection to when it happened, not to when its container was parsed", async () => {
		bootstrapFromAppHtml();

		const container = el("div", { id: "app" });

		clock = 10;
		document.body.append(container);
		await flush();

		clock = 500;
		container.append(el("grammarly-desktop-integration"));
		await flush();

		clock = 800;
		stamp(document.body, "data-gr-ext-installed", "");
		await flush();

		clock = 1200;

		const { latest } = start();
		const grammarly = latest().find((f) => f.id === "grammarly");

		expect(watch?.early).toBe(true);

		expect(grammarly).toMatchObject({
			firstSeenMs: 500,
			preexisting: false,
			evidence: ["grammarly-desktop-integration", "[data-gr-ext-installed]"],
		});
	});

	it("keeps first-seen when an unrelated attribute is written later", async () => {
		bootstrapFromAppHtml();

		const icon = el("div", { "data-lastpass-root": "" });

		clock = 100;
		stamp(document.body, "data-gr-ext-installed");
		document.body.append(icon);
		document.documentElement.classList.add("translated-ltr");
		await flush();

		clock = 800;
		stamp(document.body, "data-theme", "dark");
		stamp(icon, "style", "top: 4px");
		// Same attribute the marker reads, but the marker was already there.
		document.documentElement.classList.add("app-ready");
		await flush();

		clock = 1200;

		const { latest } = start();

		expect(watch?.early).toBe(true);

		expect(latest().map((f) => [f.id, f.firstSeenMs, f.preexisting])).toEqual([
			["grammarly", 100, false],
			["lastpass", 100, false],
			["google-translate", 100, false],
		]);

		// Same rule after take-over, on the live path.
		clock = 1500;
		stamp(document.body, "data-new-gr-c-s-check-loaded", "14.1");
		stamp(document.body, "data-theme", "light");
		await flush();

		expect(latest().find((f) => f.id === "grammarly")).toMatchObject({
			firstSeenMs: 100,
			evidence: ["[data-gr-ext-installed]", "[data-new-gr-c-s-check-loaded]"],
		});
	});

	it("keeps a preexisting marker preexisting through unrelated attribute writes", async () => {
		clock = 3;
		stamp(document.documentElement, "data-darkreader-scheme", "dark");
		bootstrapFromAppHtml();

		clock = 800;
		document.documentElement.classList.add("app-ready");
		stamp(document.documentElement, "data-theme", "dark");
		await flush();

		clock = 900;

		const { latest } = start();

		expect(watch?.early).toBe(true);

		expect(latest()).toEqual([
			{
				id: "dark-reader",
				name: "Dark Reader",
				evidence: ["html[data-darkreader-scheme]"],
				firstSeenMs: 900,
				preexisting: true,
			},
		]);
	});

	it("marks what was in the DOM before the observer started as preexisting", async () => {
		clock = 3;
		stamp(document.documentElement, "data-darkreader-scheme", "dark");
		bootstrapFromAppHtml();
		clock = 900;

		const { latest } = start();

		expect(watch?.early).toBe(true);

		expect(latest()).toEqual([
			{
				id: "dark-reader",
				name: "Dark Reader",
				evidence: ["html[data-darkreader-scheme]"],
				firstSeenMs: 900,
				preexisting: true,
			},
		]);

		// After take-over the same observer reports live.
		clock = 1500;
		document.body.append(el("vsc-controller"));
		await flush();

		expect(latest().map((f) => [f.id, f.firstSeenMs])).toEqual([
			["dark-reader", 900],
			["video-speed-controller", 1500],
		]);
	});

	it("stops reporting after stop()", async () => {
		bootstrapFromAppHtml();

		const { latest } = start();

		expect(watch?.early).toBe(true);
		watch?.stop();
		document.body.append(el("vsc-controller"));
		await flush();

		expect(latest()).toEqual([]);
	});
});
