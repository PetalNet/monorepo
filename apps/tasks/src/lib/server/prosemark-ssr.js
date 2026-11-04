import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── CodeMirror SSR ─────────────────────────────────────────────────────────
// Render a task body through the SAME ProseMark/CodeMirror engine the editor uses,
// server-side, so the read view is BYTE-IDENTICAL to edit mode (Bob: "make a
// CodeMirror SSR so it's the same rendering engine"). No second markdown renderer —
// the read HTML is literally what CodeMirror produces for an unfocused document.
//
// How it works:
//  - jsdom gives the bundle a DOM. MutationObserver is forced to a no-op so CodeMirror's
//    DOMObserver never misreads our synthetic DOM mutations as user input (that path
//    throws in jsdom). requestAnimationFrame is deferred so the layout-measure passes
//    (which need real layout and crash in jsdom) don't run during the synchronous render
//    we actually care about.
//  - We prepend a blank line so the default cursor (pos 0) parks on it; that makes the
//    blank the "active line" (revealing nothing) and every CONTENT line render with its
//    markdown marks hidden (cm-hidden-token), exactly like a read view. We then drop the
//    leading blank line from the output.
//  - XSS: CodeMirror renders raw HTML (<script>, <img onerror>, javascript: links) as
//    ESCAPED source text + highlight spans, never as live elements/attributes — so the
//    serialized HTML is safe to {@html}. (Stricter than the old rehype-sanitize allowlist.)
import { JSDOM } from "jsdom";

// static/vendor in dev (vite cwd = project root); build/client/vendor in the adapter-node
// prod build (cwd = /app, assets copied under build/client).
const BUNDLE_CANDIDATES = [
	"static/vendor/prosemark.bundle.js",
	"build/client/vendor/prosemark.bundle.js",
	"client/vendor/prosemark.bundle.js",
];

function bundleUrl() {
	for (const c of BUNDLE_CANDIDATES) {
		const p = resolve(process.cwd(), c);

		if (existsSync(p)) return pathToFileURL(p).href;
	}

	throw new Error(
		"prosemark-ssr: bundle not found (looked in " + BUNDLE_CANDIDATES.join(", ") + ")",
	);
}

let _setup = null;

function setup() {
	if (_setup) return _setup;

	_setup = (async () => {
		const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
		const w = dom.window;

		class OBS {
			observe() {}
			unobserve() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		}
		w.MutationObserver = OBS;
		w.ResizeObserver = OBS;
		w.IntersectionObserver = OBS;

		for (const [k, v] of [
			["window", w],
			["document", w.document],
			["navigator", w.navigator],
			["MutationObserver", OBS],
		]) {
			try {
				Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
			} catch {
				globalThis[k] = v;
			}
		}

		globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
		globalThis.cancelAnimationFrame = clearTimeout;

		if (!w.Window) w.Window = w.constructor || function () {};

		globalThis.Window = w.Window;

		if (!w.matchMedia)
			w.matchMedia = () => ({
				matches: false,
				media: "",
				addEventListener() {},
				removeEventListener() {},
				addListener() {},
				removeListener() {},
			});

		const mod = await import(/* @vite-ignore */ bundleUrl());

		return { w, createProseMark: mod.createProseMark };
	})();

	return _setup;
}

// Render markdown → the CodeMirror read-view HTML (the inner .cm-content lines). Returns
// '' for empty input. The async part (jsdom + bundle import) runs ONCE; each render is then
// synchronous (no await between createProseMark and serialize), so concurrent requests can't
// interleave a render on the shared window.
export async function renderBodyCM(md) {
	if (!md) return "";

	const { w, createProseMark } = await setup();
	const el = w.document.createElement("div");
	let view;

	try {
		view = createProseMark(el, "\n" + md);
		const ed = el.querySelector(".cm-editor");
		const cc = el.querySelector(".cm-content");

		if (!ed || !cc) return "";

		// content lines minus the leading blank (the parked cursor's line)
		const lines = [...cc.children].filter((n) => n.classList?.contains("cm-line")).slice(1);
		const linesHtml = lines.map((l) => l.outerHTML).join("");

		// Reconstruct the editor's own wrapper — its theme classes (ͼ1…, needed by the captured
		// CodeMirror CSS) → scroller → content — but WITHOUT the cursor/selection/gutter layers,
		// since this is a static read view. .pm-shell + the component theming wrap it on the page.
		return `<div class="${ed.className}"><div class="cm-scroller"><div class="${cc.className}">${linesHtml}</div></div></div>`;
	} catch (e) {
		console.error("prosemark-ssr render failed", e);

		return "";
	} finally {
		try {
			view?.destroy?.();
		} catch {}
	}
}
