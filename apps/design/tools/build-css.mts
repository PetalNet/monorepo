/**
 * Build the design page's stylesheet from Tailwind v4 + daisyUI (PR ds-4).
 *
 * Compiles `site/app.css` (the Tailwind entry: `@import "tailwindcss"`, `@plugin "daisyui"`, the PR
 * ds-3 paper/ink theme imports, and the page's components layer) into `site/styles.css` — the file
 * the page links.
 *
 * Tailwind v4's `compile()` (from @tailwindcss/node) returns a builder that needs the set of
 * utility candidates seen in the markup. We scan the page HTML for class tokens and feed them in,
 * so any Tailwind utility used in the markup is generated. (Today the markup uses only
 * component-layer classes, which are emitted unconditionally; the scan future-proofs the build for
 * when raw utilities get added.)
 *
 * Run with Node 26 (repo engine): node --experimental-strip-types tools/build-css.mts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Resolve @tailwindcss/node. It's a transitive dep (via @tailwindcss/vite), so
// it isn't a hoisted top-level module — find it in the pnpm store. This keeps
// the build runnable without adding a redundant direct dependency.
function resolveTailwindNode(): string {
	const require = createRequire(import.meta.url);
	try {
		return require.resolve("@tailwindcss/node");
	} catch {
		const store = resolve(here, "../../../node_modules/.pnpm");
		const dir = readdirSync(store).find((d) => d.startsWith("@tailwindcss+node@"));
		if (!dir) throw new Error("@tailwindcss/node not found in pnpm store");
		return resolve(store, dir, "node_modules/@tailwindcss/node/dist/index.mjs");
	}
}

const { compile } = (await import(
	pathToFileURL(resolveTailwindNode()).href
)) as typeof import("@tailwindcss/node");

const siteDir = resolve(here, "../site");
const entry = resolve(siteDir, "app.css");
const html = resolve(siteDir, "index.html");
const out = resolve(siteDir, "styles.css");

const css = readFileSync(entry, "utf8");

// This page styles itself ENTIRELY through its component layer (bespoke .btn /
// .card-* / .tile / … classes). It deliberately uses NO raw Tailwind utilities.
// Crucially, some of its semantic class names overlap Tailwind utility NAMES —
// e.g. `.ring` (a no-op marker in the source) is also Tailwind's `ring` shadow
// utility. If we fed the markup's classes in as candidates, Tailwind would
// materialise those utilities and they'd paint over the page (the `.ring`
// swatch picking up a 1px inset ring is exactly that bug). So we build with NO
// candidates: only the component layer + daisyUI theme/base are emitted, which
// is the whole stylesheet this page needs.
//
// (If a future revision of the page adopts real Tailwind utilities, scan the
// markup for class tokens here and pass them to build(); keep page-semantic
// names that collide with utility names — `ring`, `link`, `status`, … — OUT.)
void html; // markup is the render target, not a utility source (see above)

const compiler = await compile(css, {
	base: siteDir,
	onDependency: () => {},
});

const result = compiler.build([]);

writeFileSync(out, result, "utf8");
console.log(`built ${out} (${result.length} bytes)`);
