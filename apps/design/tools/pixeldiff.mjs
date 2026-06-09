import { writeFileSync, readFileSync } from "node:fs";

import pixelmatch from "pixelmatch";
// Full-page screenshot diff: source design page vs the Tailwind+daisyUI rebuild.
// Captures both with reducedMotion:'reduce' (freezes the time-dependent skeleton
// shimmer, per the design README) at a fixed viewport, full page, then reports
// the differing-pixel count and ratio. Usage:
//   node pixeldiff.mjs <urlA> <urlB> <outDir> [theme] [width]
import { chromium } from "playwright";
import { PNG } from "pngjs";

const [urlA, urlB, outDir = "/tmp/dsdiff", theme = "light", width = "1280"] = process.argv.slice(2);

async function shoot(url, file) {
	const b = await chromium.launch();
	const ctx = await b.newContext({
		viewport: { width: +width, height: 1000 },
		reducedMotion: "reduce",
		colorScheme: theme === "dark" ? "dark" : "light",
	});
	const p = await ctx.newPage();
	await p.addInitScript((t) => {
		try {
			localStorage.setItem("petalnet-theme", t);
		} catch {}
	}, theme);
	await p.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
	await p.waitForTimeout(800);
	await p.screenshot({ path: file, fullPage: true });
	await b.close();
}

const fa = `${outDir}/a-${theme}.png`;
const fb = `${outDir}/b-${theme}.png`;
await shoot(urlA, fa);
await shoot(urlB, fb);

const a = PNG.sync.read(readFileSync(fa));
const b = PNG.sync.read(readFileSync(fb));
const w = Math.min(a.width, b.width);
const h = Math.min(a.height, b.height);
const diff = new PNG({ width: w, height: h });
// crop both to common size
function crop(src) {
	const out = new PNG({ width: w, height: h });
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const si = (src.width * y + x) << 2;
			const di = (w * y + x) << 2;
			out.data[di] = src.data[si];
			out.data[di + 1] = src.data[si + 1];
			out.data[di + 2] = src.data[si + 2];
			out.data[di + 3] = src.data[si + 3];
		}
	return out;
}
const ca = crop(a);
const cb = crop(b);
const n = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.1 });
writeFileSync(`${outDir}/diff-${theme}.png`, PNG.sync.write(diff));
const total = w * h;
console.log(
	JSON.stringify({
		theme,
		dimsA: [a.width, a.height],
		dimsB: [b.width, b.height],
		compared: [w, h],
		diffPixels: n,
		ratio: +(n / total).toFixed(6),
	}),
);
