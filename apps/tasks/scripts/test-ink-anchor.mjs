#!/usr/bin/env node
// Pencil ink must stay on the content it was drawn over when another browser lays the page out
// differently. Draws marks with real pointer events in one layout, re-renders them in a layout
// with wider, taller text, and checks each mark still covers its target. Then strips the anchors
// and checks the same assertion catches the drift.
//
//   PLAYWRIGHT_DIR=/home/docker/shotty node scripts/test-ink-anchor.mjs [--shots dir]
//
// Needs Playwright with Chromium, so it is not part of `pnpm test`.
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

import { inkLayer } from "../src/lib/ink.js";

const { values: opts } = parseArgs({ options: { shots: { type: "string" } } });
const req = process.env.PLAYWRIGHT_DIR
	? createRequire(path.join(process.env.PLAYWRIGHT_DIR, "noop.js"))
	: createRequire(import.meta.url);
const { chromium } = req("playwright");

const filler = (n) =>
	Array.from(
		{ length: n },
		(_, i) => `<p>Paragraph ${i} that wraps across lines when the font widens.</p>`,
	).join("");

const PAGE = `<!doctype html><html><head><style>
body{margin:0;padding:24px 40px;font:16px/1.3 sans-serif;width:auto}
h1{font-size:72px;line-height:1.05;margin:0 0 20px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.scroller{height:200px;overflow-y:auto;border:1px solid #ccc}
.scroller li{height:60px}
.q{display:flex;gap:12px;border-top:1px solid #ddd;padding:12px 0}
</style><style id="layout"></style></head><body>
<h1>Open questions for the pencil test page.</h1>
${filler(8)}
<div class="cols"><div>${filler(5)}</div><ul id="waiting"><li>first draft</li><li>second draft</li><li>third draft</li></ul></div>
${filler(6)}
<div class="q" data-t="q1"><b>01</b><span>Who decides where a season starts and ends?</span></div>
<div class="q" data-t="q2"><b>02</b><span>We need an export-control compliance read.</span></div>
${filler(10)}
<ul class="scroller">${Array.from({ length: 12 }, (_, i) => `<li data-t="row${i}">row ${i}</li>`).join("")}</ul>
${filler(4)}
<p data-t="bullet">Teams already post in Discord; the bridge turns a photo into a post.</p>
${filler(20)}
</body></html>`;

// Layout B: the same page as a browser with a much wider, taller font would draw it.
const WIDE = "body,h1{font-family:monospace;letter-spacing:.06em;line-height:1.7}";
const TARGETS = ["#waiting", '[data-t="q2"]', '[data-t="bullet"]', '[data-t="row7"]'];
const LAYER = `window.__strokes=[];window.__ink=(${inkLayer.toString()})(window,{emit(m){if(m.ink==='change')window.__strokes=m.strokes}});`;

const browser = await chromium.launch();
let failed = 0;

function check(name, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
	failed += ok ? 0 : 1;
}

async function open(css) {
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

	await page.setContent(PAGE);
	await page.evaluate((c) => (document.getElementById("layout").textContent = c), css);
	await page.evaluate(LAYER);

	return page;
}

// Ring a target with the mouse; returns the page box drawn around.
async function ring(page, sel) {
	await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "center" }), sel);

	const r = await page.evaluate((s) => {
		const b = document.querySelector(s).getBoundingClientRect();

		return { x: b.left, y: b.top, w: b.width, h: b.height };
	}, sel);
	const cx = r.x + Math.min(r.w, 300) / 2;
	const cy = r.y + r.h / 2;
	const rx = Math.min(r.w, 300) / 2 + 10;
	const ry = r.h / 2 + 8;

	await page.mouse.move(cx + rx, cy);
	await page.mouse.down();

	for (let a = 0; a <= 2 * Math.PI + 0.01; a += Math.PI / 16) {
		await page.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
	}

	await page.mouse.up();
}

// Whether each stroke's drawn centre sits inside the target it was drawn around.
function onTarget(page) {
	return page.evaluate((targets) => {
		const paths = [...document.querySelectorAll("svg[data-ink] path")];

		return targets.map((sel, i) => {
			const t = document.querySelector(sel).getBoundingClientRect();
			const p = paths[i].getBoundingClientRect();
			const cx = p.left + p.width / 2;
			const cy = p.top + p.height / 2;

			return {
				sel,
				hit: cx >= t.left && cx <= t.right && cy >= t.top && cy <= t.bottom,
				dy: Math.round(cy - (t.top + t.height / 2)),
			};
		});
	}, TARGETS);
}

async function show(page, strokes, file) {
	await page.evaluate((s) => window.__ink.handle({ ink: "set", strokes: s }), strokes);

	if (opts.shots && file) {
		await page.screenshot({ path: path.join(opts.shots, file), fullPage: true });
	}

	return onTarget(page);
}

try {
	const a = await open("");

	await a.evaluate(() => window.__ink.handle({ ink: "arm", on: true }));
	await a.evaluate(() => document.querySelector('[data-t="row0"]').closest("ul").scrollTo(0, 300));

	for (const sel of TARGETS) {
		await ring(a, sel);
	}

	const drawn = await a.evaluate(() => window.__strokes);

	check(
		"every drawn stroke is anchored",
		drawn.length === TARGETS.length && drawn.every((s) => s.anchor),
	);

	check(
		"the stroke on the scrolled list anchors inside the scroller",
		/^\/1\/\d+\/7$/.test(drawn[3].anchor?.p ?? ""),
		drawn[3].anchor?.p,
	);

	const legacy = drawn.map(({ anchor: _anchor, ...s }) => s);

	await a.evaluate(() => window.__ink.handle({ ink: "arm", on: false }));
	await a.evaluate((s) => window.__ink.handle({ ink: "set", strokes: s }), legacy);
	await a.evaluate(() => window.__ink.handle({ ink: "arm", on: true }));
	const rescued = await a.evaluate(() => window.__strokes);

	check(
		"arming the layout a legacy stroke was drawn in anchors it",
		rescued.length === legacy.length && rescued.every((s) => s.anchor),
	);

	const b = await open(WIDE);

	await b.evaluate(() => document.querySelector('[data-t="row0"]').closest("ul").scrollTo(0, 300));

	for (const [name, strokes, file] of [
		["anchored", drawn, "ink-anchor-wide-anchored.png"],
		["re-anchored legacy", rescued, "ink-anchor-wide-rescued.png"],
	]) {
		const res = await show(b, strokes, file);

		for (const r of res) {
			check(`${name} stroke stays on ${r.sel} in the wide layout`, r.hit, `dy=${r.dy}`);
		}
	}

	const bare = await show(b, legacy, "ink-anchor-wide-unanchored.png");
	const drift = bare.filter((r) => !r.hit);

	check(
		"without anchors the same check catches the drift",
		drift.length >= 2,
		bare.map((r) => `${r.sel} dy=${r.dy}`).join(", "),
	);

	const narrow = await browser.newPage({ viewport: { width: 700, height: 700 } });

	await narrow.setContent(PAGE);
	await narrow.evaluate(LAYER);
	await narrow.evaluate(() =>
		document.querySelector('[data-t="row0"]').closest("ul").scrollTo(0, 300),
	);
	await narrow.evaluate(() => window.__ink.handle({ ink: "arm", on: true }));
	await narrow.evaluate((s) => window.__ink.handle({ ink: "set", strokes: s }), legacy);
	await narrow.evaluate(() => window.__ink.handle({ ink: "arm", on: true }));

	check(
		"a different page width does not re-anchor legacy strokes",
		(await narrow.evaluate(() => window.__strokes)).length === 0,
	);
} finally {
	await browser.close();
}

if (failed) {
	console.log(`${failed} check(s) failed`);
	process.exit(1);
}

console.log("all checks passed");
