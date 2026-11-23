// /engines/<name>.png — the "via" row engine mark.
//
// LOGO BUG FIX (task-142 follow-up): the mini engine logos were flaky because
// every one was fetched live from favicons.petalcat.dev; when that service was
// slow/down the icon fell back to a colored dot and flickered. Now every engine
// serp-fetch actually uses ships a LOCAL, self-contained SVG monogram served
// instantly with no network call — so their logos never flake. Unknown engines
// still resolve via the favicon service (cached), and the colored-dot fallback
// in EngineIcon.svelte remains the last resort.

import type { RequestHandler } from "./$types";

// Brand-ish colors for the local monograms (kept in sync with ENGINE_COLORS).
const ENGINE_COLORS: Record<string, string> = {
	google: "#4285f4",
	bing: "#00897b",
	duckduckgo: "#de5833",
	brave: "#fb542b",
	mojeek: "#c4683b",
	startpage: "#2358b8",
	marginalia: "#8a3a1f",
	wikipedia: "#999999",
	qwant: "#5c97ff",
	mwmbl: "#e6a817",
};

// Glyph shown on the monogram (usually the initial; a couple of overrides).
const ENGINE_GLYPH: Record<string, string> = {
	google: "G",
	bing: "b",
	duckduckgo: "D",
	brave: "B",
	mojeek: "M",
	startpage: "S",
	marginalia: "m",
	qwant: "Q",
	mwmbl: "w",
};

// Engines that get a guaranteed local icon (serp-fetch's set + a few common).
const LOCAL_ICONS = new Set(Object.keys(ENGINE_GLYPH));

function localMonogram(name: string): string {
	const color = ENGINE_COLORS[name] || "#5a6b7b";
	const glyph = ENGINE_GLYPH[name] || (name[0] || "?").toUpperCase();

	// Rounded square, brand color, centered white glyph. 64×64, crisp at any size.
	return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${name}">
  <rect width="64" height="64" rx="14" fill="${color}"/>
  <text x="32" y="33" text-anchor="middle" dominant-baseline="central"
    font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
    font-size="38" font-weight="700" fill="#ffffff">${glyph}</text>
</svg>`;
}

const ENGINE_DOMAINS: Record<string, string> = {
	google: "google.com",
	bing: "bing.com",
	duckduckgo: "duckduckgo.com",
	brave: "search.brave.com",
	mojeek: "mojeek.com",
	marginalia: "marginalia-search.com",
	startpage: "startpage.com",
	qwant: "qwant.com",
	mwmbl: "mwmbl.org",
	yahoo: "yahoo.com",
	yandex: "yandex.com",
	wikipedia: "wikipedia.org",
	wikidata: "wikidata.org",
	github: "github.com",
	gitlab: "gitlab.com",
	codeberg: "codeberg.org",
	stackoverflow: "stackoverflow.com",
	reddit: "reddit.com",
	youtube: "youtube.com",
	arxiv: "arxiv.org",
	npm: "npmjs.com",
	pypi: "pypi.org",
	mdn: "developer.mozilla.org",
	openstreetmap: "openstreetmap.org",
	wolframalpha: "wolframalpha.com",
};

type Cached = { buf: ArrayBuffer; type: string } | "miss";
const ICACHE = new Map<string, Cached>();

const engineDomain = (name: string) => {
	const n = (name || "").toLowerCase().trim();

	return ENGINE_DOMAINS[n] || ENGINE_DOMAINS[n.split(/[\s_]/)[0]] || null;
};

async function loadEngineIcon(name: string): Promise<{ buf: ArrayBuffer; type: string } | null> {
	const hit = ICACHE.get(name);

	if (hit) return hit === "miss" ? null : hit;

	const d = engineDomain(name);

	if (!d) {
		ICACHE.set(name, "miss");

		return null;
	}

	try {
		const r = await fetch(`https://favicons.petalcat.dev/favicon?url=https://${d}&size=64`, {
			signal: AbortSignal.timeout(8000),
		});

		if (!r.ok) throw new Error("fav " + r.status);

		const obj = { type: r.headers.get("content-type") || "image/png", buf: await r.arrayBuffer() };

		ICACHE.set(name, obj);

		return obj;
	} catch {
		return null; // transient: don't cache as miss → retries
	}
}

export const GET: RequestHandler = async ({ params }) => {
	const name = (params.name || "").replace(/\.png$/i, "").toLowerCase();

	// Local monogram first for known engines — instant, offline, never flaky.
	if (LOCAL_ICONS.has(name) || ENGINE_COLORS[name]) {
		return new Response(localMonogram(name), {
			headers: {
				"Content-Type": "image/svg+xml; charset=utf-8",
				"Cache-Control": "public, max-age=604800, immutable",
			},
		});
	}

	// Unknown engine → resolve its real favicon (cached); dot fallback on failure.
	const ic = await loadEngineIcon(name);

	if (!ic) return new Response("no icon", { status: ICACHE.get(name) === "miss" ? 404 : 502 });

	return new Response(ic.buf, {
		headers: { "Content-Type": ic.type, "Cache-Control": "public, max-age=604800" },
	});
};
