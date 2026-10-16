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

interface Marker {
	indicatorId: string;
	selector: string;
	/** The one attribute the selector reads (`id` for `#x`, `class` for `.x`), or null for a bare tag. */
	attribute: string | null;
}

function attributeOf(selector: string): string | null {
	const names = [
		...Array.from(selector.matchAll(/\[([\w-]+)/g), (m) => m[1]),
		...(/#[\w-]/.test(selector) ? ["id"] : []),
		...(/\.[\w-]/.test(selector) ? ["class"] : []),
	];

	if (names.length > 1) {
		throw new Error(`indicator selector reads more than one attribute: ${selector}`);
	}

	return names[0] ?? null;
}

const MARKERS: readonly Marker[] = INDICATORS.flatMap((i) =>
	i.selectors.map((selector) => ({
		indicatorId: i.id,
		selector,
		attribute: attributeOf(selector),
	})),
);

const ANY_SELECTOR = MARKERS.map((m) => m.selector).join(",");

function isElement(node: Node): node is Element {
	return node.nodeType === Node.ELEMENT_NODE;
}

/** `el` and its descendants that currently carry any marker. */
function candidates(el: Element): Element[] {
	const found = el.matches(ANY_SELECTOR) ? [el] : [];

	found.push(...el.querySelectorAll(ANY_SELECTOR));

	return found;
}

/** Every marker present in `el`'s subtree right now. */
function matchSubtree(el: Element): DomHit[] {
	return candidates(el).flatMap((node) =>
		MARKERS.filter((m) => node.matches(m.selector)).map((m) => ({
			indicatorId: m.indicatorId,
			evidence: m.selector,
			element: node,
		})),
	);
}

// Probes live in an inert document: no custom-element registry, so building one never runs an
// extension's element constructor.
let inert: Document | null = null;

/** Does `marker` match `el` when its attribute holds `value` (null: absent)? */
function matchesWith(el: Element, marker: Marker, value: string | null): boolean {
	if (marker.attribute === null) {
		return el.matches(marker.selector);
	}

	inert ??= document.implementation.createHTMLDocument("");

	// Every selector reads only the tag plus `marker.attribute`, so that is all the probe needs.
	const probe = inert.createElement(el.localName);

	if (value !== null) {
		probe.setAttribute(marker.attribute, value);
	}

	return probe.matches(marker.selector);
}

type Batch = readonly [t: number, records: readonly MutationRecord[]];
type TimedHit = DomHit & { t: number };

/**
 * Classify records in order, crediting each marker to the record that made it appear.
 *
 * The DOM can only be read as it is now, so each record is judged against the attribute values it
 * left behind: the next record's `oldValue` for that element and attribute, or the current value if
 * none followed. An attribute record claims only markers that read that attribute and that it
 * turned from non-matching to matching; unrelated writes claim nothing. An insertion claims markers
 * that matched as inserted, but not nodes put under it later: a buffered `<body>` insertion must
 * not take credit for what was injected into body afterwards.
 */
function classifyBatches(batches: readonly Batch[]): TimedHit[] {
	const flat = batches.flatMap(([t, records]) => records.map((r) => ({ t, r })));
	const lastAdded = new Map<Node, number>();
	const writes = new Map<Node, Map<string, { i: number; oldValue: string | null }[]>>();

	for (const [i, { r }] of flat.entries()) {
		for (const node of r.addedNodes) {
			lastAdded.set(node, i);
		}

		if (r.type === "attributes" && r.attributeName !== null) {
			const byName =
				writes.get(r.target) ?? new Map<string, { i: number; oldValue: string | null }[]>();
			const list = byName.get(r.attributeName) ?? [];

			list.push({ i, oldValue: r.oldValue });
			byName.set(r.attributeName, list);
			writes.set(r.target, byName);
		}
	}

	function valueAfter(el: Element, name: string, i: number): string | null {
		const next = writes
			.get(el)
			?.get(name)
			?.find((w) => w.i > i);

		return next ? next.oldValue : el.getAttribute(name);
	}

	function hits(el: Element, markers: readonly Marker[], keep: (m: Marker) => boolean): DomHit[] {
		return markers
			.filter((m) => keep(m))
			.map((m) => ({ indicatorId: m.indicatorId, evidence: m.selector, element: el }));
	}

	function classify(r: MutationRecord, i: number): DomHit[] {
		if (r.type === "childList") {
			return Array.from(r.addedNodes)
				.filter(isElement)
				.flatMap((added) =>
					candidates(added)
						.filter((el) => {
							// Skip nodes that were put under `added` after this record.
							for (let a: Node | null = el; a && a !== added; a = a.parentNode) {
								if ((lastAdded.get(a) ?? i) > i) {
									return false;
								}
							}

							return true;
						})
						.flatMap((el) =>
							hits(el, MARKERS, (m) =>
								matchesWith(el, m, m.attribute === null ? null : valueAfter(el, m.attribute, i)),
							),
						),
				);
		}

		const name = r.attributeName;

		if (r.type !== "attributes" || name === null || !isElement(r.target)) {
			return [];
		}

		const target = r.target;
		const after = valueAfter(target, name, i);

		if (target === target.ownerDocument.documentElement && name === "lang") {
			if (r.oldValue === null || after === null || after === r.oldValue) {
				return [];
			}

			return INDICATORS.filter((ind) => ind.langRewrite).map((ind) => ({
				indicatorId: ind.id,
				evidence: `html[lang] rewritten "${r.oldValue ?? ""}" → "${after}"`,
				element: null,
			}));
		}

		return hits(
			target,
			MARKERS.filter((m) => m.attribute === name),
			(m) => matchesWith(target, m, after) && !matchesWith(target, m, r.oldValue),
		);
	}

	return flat.flatMap(({ t, r }, i) => classify(r, i).map((hit) => ({ ...hit, t })));
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
