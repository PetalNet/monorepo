#!/usr/bin/env node
// Render a gallery artifact with one author's pencil ink to a PNG, so an agent can look at the
// marks instead of reading coordinates.
//
//   TASKS_URL=http://127.0.0.1:8896 TASKS_AGENT_TOKEN=<unscoped token> \
//     node scripts/render-markup.mjs <slug> [--author <name>] [--out file.png] [--width N] [--dark] [--full]
//
// Fetches the page and its strokes through the agent API (get_markup with content), lays the
// page out at the width the strokes were drawn at (the most common stroke vw, unless --width),
// and draws the ink with the same inkLayer the viewer uses, so anchored strokes land on the
// elements they were drawn over even where this browser's fonts wrap text differently. The PNG is cropped to the marks plus
// a margin of page around them; --full captures the whole page. TASKS_AGENT_TOKEN_FILE may name a
// file holding the token. Needs Playwright with Chromium; PLAYWRIGHT_DIR points at a directory
// whose node_modules has it when this checkout doesn't.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

import { inkLayer } from "../src/lib/ink.js";

const { values: opts, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		author: { type: "string" },
		out: { type: "string" },
		width: { type: "string" },
		dark: { type: "boolean", default: false },
		full: { type: "boolean", default: false },
	},
});
const slug = positionals[0];
const base = process.env.TASKS_URL;
const token =
	process.env.TASKS_AGENT_TOKEN ??
	(process.env.TASKS_AGENT_TOKEN_FILE
		? readFileSync(process.env.TASKS_AGENT_TOKEN_FILE, "utf8").trim()
		: undefined);

if (!slug || !base || !token) {
	console.error(
		"usage: TASKS_URL=… TASKS_AGENT_TOKEN=… node scripts/render-markup.mjs <slug> [--author name] [--out file.png] [--width N] [--dark] [--full]",
	);

	process.exit(2);
}

const res = await fetch(new URL("/api/agent/rpc", base), {
	method: "POST",
	headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
	body: JSON.stringify({ op: "get_markup", args: { slug, content: true } }),
});
const body = await res.json();

if (!res.ok) {
	console.error(`get_markup ${slug}: ${res.status} ${body.error ?? ""}`);
	process.exit(1);
}

const markup = opts.author
	? body.markups.find((m) => m.author === opts.author)
	: body.markups.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
const strokes = markup?.strokes ?? [];
const widths = new Map();

for (const s of strokes) {
	widths.set(s.vw, (widths.get(s.vw) ?? 0) + 1);
}

const width = Number(opts.width) || [...widths].toSorted((a, b) => b[1] - a[1])[0]?.[0] || 1024;
const offWidth = strokes.filter((s) => s.vw !== width && !s.anchor).length;
const req = process.env.PLAYWRIGHT_DIR
	? createRequire(path.join(process.env.PLAYWRIGHT_DIR, "noop.js"))
	: createRequire(import.meta.url);
const { chromium } = req("playwright");
const browser = await chromium.launch();

try {
	// Keep the gallery's cage: html pages run no scripts there and no page gets the network.
	// The ink is drawn over CDP, which page script settings don't gate.
	const ctx = await browser.newContext({
		viewport: { width, height: 1366 },
		deviceScaleFactor: 2,
		colorScheme: opts.dark ? "dark" : "light",
		javaScriptEnabled: body.kind === "interactive",
		offline: true,
	});

	await ctx.route(/^(?!data:|about:)/u, (route) => route.abort());
	const page = await ctx.newPage();

	await page.setContent(body.content, { waitUntil: "load" });
	// Anchored strokes follow the layout, so let it settle before they are placed.
	await page.evaluate(() => document.fonts.ready);

	await page.evaluate(
		`(${inkLayer.toString()})(window, { emit() {} }).handle({ ink: "set", strokes: ${JSON.stringify(strokes)} })`,
	);

	await page.waitForTimeout(300);
	const file = opts.out ?? `markup-${slug}${markup ? `-${markup.author}` : ""}.png`;

	const marks = await page.evaluate(() => {
		const boxes = [...document.querySelectorAll("svg[data-ink] path")].map((p) =>
			p.getBoundingClientRect(),
		);

		return boxes.length === 0
			? null
			: {
					top: Math.min(...boxes.map((b) => b.top)) + window.scrollY,
					bottom: Math.max(...boxes.map((b) => b.bottom)) + window.scrollY,
				};
	});
	const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
	const clipTop = marks ? Math.max(0, marks.top - 400) : 0;
	const clip =
		marks && !opts.full
			? { x: 0, y: clipTop, width, height: Math.min(pageHeight, marks.bottom + 400) - clipTop }
			: undefined;

	await page.screenshot({ path: file, fullPage: true, clip });

	console.log(
		JSON.stringify({
			png: file,
			slug,
			author: markup?.author ?? null,
			strokes: strokes.length,
			updated_at: markup?.updated_at ?? null,
			width,
			region: clip ? { top: clip.y, height: clip.height } : "full page",
			...(offWidth
				? {
						warning: `${offWidth} unanchored stroke(s) were drawn at another page width and may be offset`,
					}
				: {}),
		}),
	);
} finally {
	await browser.close();
}
