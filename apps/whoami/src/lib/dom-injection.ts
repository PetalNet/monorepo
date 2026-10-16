// Extension detection by DOM injection. Many extensions write into the page they run
// on: Grammarly mounts a custom element and stamps <body>, password managers drop
// icons and save bars next to login fields, Dark Reader stamps <html> and adds its
// own <style> nodes, Google Translate rewrites classes and `lang`. Page JavaScript can
// watch all of that with a MutationObserver.
//
// app.html starts the observer in <head>, before the body is parsed or painted, and
// only buffers records. This module drains that buffer, classifies against
// INDICATORS, and keeps classifying for the life of the page, because most of these
// extensions inject lazily (on focus of a text or password field, or after load).
//
// A clean result is ambiguous. Most extensions never touch the DOM; password
// managers and Grammarly usually wait for a field this page doesn't have; Bitwarden
// deliberately randomizes its inline-menu element names; closed shadow roots hide
// their contents. "Nothing seen" is not "nothing installed".
//
// Everything runs locally. Nothing is sent anywhere.

export interface DomIndicator {
	id: string;
	name: string;
	/** CSS selectors for the injected nodes or attributes. Each one is reported as evidence. */
	selectors: readonly string[];
	/** Also match a rewrite of <html lang> after load (page translators do this). */
	langRewrite?: boolean;
}

// Open-source extensions were checked against their source: Dark Reader
// (src/inject), Bitwarden (apps/browser/src/autofill), Proton Pass
// (applications/pass-extension), Video Speed Controller. The closed-source entries
// are the markers those extensions are widely seen to leave (they show up in
// framework hydration-mismatch reports). Page-set opt-out attributes such as
// data-1p-ignore, data-lpignore and data-bwignore are deliberately absent: the
// page writes those, not the extension.
export const INDICATORS: readonly DomIndicator[] = [
	{
		id: "grammarly",
		name: "Grammarly",
		selectors: [
			"grammarly-desktop-integration",
			"grammarly-extension",
			"grammarly-popups",
			"[data-grammarly-shadow-root]",
			"[data-gr-ext-installed]",
			"[data-new-gr-c-s-check-loaded]",
		],
	},
	{
		id: "1password",
		name: "1Password",
		selectors: ["com-1password-button", "com-1password-menu", "[data-com-onepassword-filled]"],
	},
	{
		id: "bitwarden",
		name: "Bitwarden",
		selectors: [
			"bit-notification-bar-root",
			"#bit-notification-bar",
			"#bit-notification-bar-iframe",
		],
	},
	{
		id: "lastpass",
		name: "LastPass",
		selectors: ["[data-lastpass-icon-root]", "[data-lastpass-root]"],
	},
	{
		id: "dashlane",
		name: "Dashlane",
		selectors: ["[data-dashlane-rid]", "[data-dashlane-classification]", "[data-kwimpalastatus]"],
	},
	{
		id: "proton-pass",
		name: "Proton Pass",
		selectors: ["[data-protonpass-role]"],
	},
	{
		id: "dark-reader",
		name: "Dark Reader",
		selectors: [
			"html[data-darkreader-mode]",
			"html[data-darkreader-scheme]",
			'meta[name="darkreader"]',
			"style.darkreader",
			"[data-darkreader-inline-bgcolor]",
			"[data-darkreader-inline-color]",
		],
	},
	{
		id: "google-translate",
		name: "Google Translate (extension or Chrome's built-in)",
		selectors: [
			"html.translated-ltr",
			"html.translated-rtl",
			"#goog-gt-tt",
			".goog-te-banner-frame",
		],
	},
	{
		id: "page-translation",
		name: "Page translator (unnamed)",
		selectors: [],
		langRewrite: true,
	},
	{
		id: "video-speed-controller",
		name: "Video Speed Controller",
		selectors: ["vsc-controller"],
	},
];

interface DomHit {
	indicatorId: string;
	evidence: string;
	/** The element that matched; null when the record itself is the evidence. */
	element: Element | null;
}

export interface DomFinding {
	id: string;
	name: string;
	evidence: string[];
	/** Performance.now() at first sighting: milliseconds after navigation start. */
	firstSeenMs: number;
	/** Already in the DOM when the observer started, so no mutation was seen for it. */
	preexisting: boolean;
}

const ANY_SELECTOR = INDICATORS.flatMap((i) => i.selectors).join(",");

function isElement(node: Node): node is Element {
	return node.nodeType === Node.ELEMENT_NODE;
}

function selectorHits(el: Element): DomHit[] {
	return INDICATORS.flatMap((i) =>
		i.selectors
			.filter((selector) => el.matches(selector))
			.map((evidence) => ({ indicatorId: i.id, evidence, element: el })),
	);
}

/** Match an element and its whole subtree against the table. */
function matchSubtree(el: Element): DomHit[] {
	const found = el.matches(ANY_SELECTOR) ? [el] : [];

	found.push(...el.querySelectorAll(ANY_SELECTOR));

	return found.flatMap(selectorHits);
}

function classifyRecord(record: MutationRecord): DomHit[] {
	if (record.type === "childList") {
		return Array.from(record.addedNodes).filter(isElement).flatMap(matchSubtree);
	}

	if (record.type !== "attributes" || !isElement(record.target)) {
		return [];
	}

	const target = record.target;
	const root = target.ownerDocument.documentElement;

	if (target === root && record.attributeName === "lang") {
		const now = root.getAttribute("lang");

		if (record.oldValue === null || now === null || now === record.oldValue) {
			return [];
		}

		return INDICATORS.filter((i) => i.langRewrite).map((i) => ({
			indicatorId: i.id,
			evidence: `html[lang] rewritten "${record.oldValue ?? ""}" → "${now}"`,
			element: null,
		}));
	}

	// Only the element whose attribute changed; its subtree didn't change.
	return selectorHits(target);
}

type Batch = readonly [t: number, records: readonly MutationRecord[]];
type TimedHit = DomHit & { t: number };

/**
 * Classify records in order. Matching reads the DOM as it is NOW, not as it was when the record
 * fired, so a buffered `<body>` insertion would otherwise take credit for everything injected into
 * body later. A hit is credited to the last record that touched its element, and a subtree hit is
 * dropped when some ancestor below the inserted node was itself inserted later (that later record
 * takes it).
 */
function classifyBatches(batches: readonly Batch[]): TimedHit[] {
	const flat = batches.flatMap(([t, records]) => records.map((r) => ({ t, r })));
	const lastTouch = new Map<Node, number>();
	const lastAdded = new Map<Node, number>();

	for (const [i, { r }] of flat.entries()) {
		if (r.type === "attributes") {
			lastTouch.set(r.target, i);
		}

		for (const node of r.addedNodes) {
			lastTouch.set(node, i);
			lastAdded.set(node, i);
		}
	}

	return flat.flatMap(({ t, r }, i) =>
		classifyRecord(r)
			.filter(({ element }) => {
				if (!element) {
					return true;
				}

				if ((lastTouch.get(element) ?? i) > i) {
					return false;
				}

				if (r.type !== "childList") {
					return true;
				}

				for (let a = element.parentNode; a && a !== r.target; a = a.parentNode) {
					if ((lastAdded.get(a) ?? i) > i) {
						return false;
					}
				}

				return true;
			})
			.map((hit) => ({ ...hit, t })),
	);
}

/** What app.html's inline bootstrap leaves on window. Keep in step with app.html. */
interface EarlyDomWatch {
	t0: number;
	q: [number, MutationRecord[]][];
	o: MutationObserver;
	cb: ((records: MutationRecord[], t: number) => void) | null;
}

declare global {
	interface Window {
		whoamiDomWatch?: EarlyDomWatch;
	}
}

const OBSERVE_OPTIONS: MutationObserverInit = {
	childList: true,
	subtree: true,
	attributes: true,
	attributeOldValue: true,
};

export interface DomWatch {
	/** Performance.now() when the observer started. */
	startedAt: number;
	/** True when app.html's pre-paint observer was found; false means this module started late. */
	early: boolean;
	stop: () => void;
}

/**
 * Take over the early observer (or start one), classify everything it saw, then keep watching.
 * `onChange` gets the full finding list, ordered by first sighting, each time it changes.
 */
export function watchDomInjection(onChange: (findings: DomFinding[]) => void): DomWatch {
	const findings = new Map<string, DomFinding>();

	function record(hits: readonly TimedHit[], preexisting: boolean): boolean {
		let changed = false;

		for (const hit of hits) {
			const indicator = INDICATORS.find((i) => i.id === hit.indicatorId);

			if (!indicator) {
				continue;
			}

			const finding = findings.get(hit.indicatorId);

			if (!finding) {
				findings.set(hit.indicatorId, {
					id: indicator.id,
					name: indicator.name,
					evidence: [hit.evidence],
					firstSeenMs: hit.t,
					preexisting,
				});

				changed = true;
			} else if (!finding.evidence.includes(hit.evidence)) {
				finding.evidence.push(hit.evidence);
				changed = true;
			}
		}

		return changed;
	}

	function emit() {
		onChange(
			[...findings.values()]
				.map((f) => ({ ...f, evidence: [...f.evidence] }))
				.toSorted((a, b) => a.firstSeenMs - b.firstSeenMs),
		);
	}

	function handle(records: MutationRecord[], t: number) {
		if (record(classifyBatches([[t, records]]), false)) {
			emit();
		}
	}

	const early = window.whoamiDomWatch;
	let own: MutationObserver | null = null;
	let startedAt: number;

	if (early) {
		startedAt = early.t0;

		// takeRecords() hands over what the observer queued but hasn't delivered yet.
		const pending: Batch = [performance.now(), early.o.takeRecords()];

		record(classifyBatches([...early.q.splice(0), pending]), false);
		early.cb = handle;
	} else {
		startedAt = performance.now();

		own = new MutationObserver((records) => {
			handle(records, performance.now());
		});

		own.observe(document.documentElement, OBSERVE_OPTIONS);
	}

	// Anything in the DOM now that no record accounted for was there before the
	// observer started (a document_start content script can beat even an inline
	// <head> script).
	const now = performance.now();

	record(
		matchSubtree(document.documentElement).map((hit) => ({ ...hit, t: now })),
		true,
	);

	emit();

	return {
		startedAt,
		early: early !== undefined,
		stop: () => {
			// The early observer keeps running and goes back to buffering.
			if (early) {
				early.cb = null;
			}

			own?.disconnect();
		},
	};
}
