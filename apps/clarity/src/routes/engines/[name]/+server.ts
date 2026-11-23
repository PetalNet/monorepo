import type { RequestHandler } from "./$types";

// Colors for engines that ship a local monogram.
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

function localMonogram(name: string): string {
	const color = ENGINE_COLORS[name];
	const glyph = ENGINE_GLYPH[name] ?? name.slice(0, 1).toUpperCase();

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

interface Icon {
	buffer: ArrayBuffer;
	type: string;
}

const icons = new Map<string, Promise<Icon | undefined>>();
const iconTypes = new Set([
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/svg+xml",
	"image/vnd.microsoft.icon",
	"image/webp",
	"image/x-icon",
]);

function iconResponse(body: BodyInit, type: string): Response {
	return new Response(body, {
		headers: {
			"Content-Type": type,
			"Cache-Control": "public, max-age=604800",
			"Content-Security-Policy": "default-src 'none'; sandbox",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

async function fetchIcon(domain: string): Promise<Icon | undefined> {
	const url = new URL("https://favicons.petalcat.dev/favicon");

	url.searchParams.set("url", `https://${domain}`);
	url.searchParams.set("size", "64");

	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
		const type = response.headers.get("content-type")?.split(";").at(0)?.trim().toLowerCase();

		if (!response.ok || !type || !iconTypes.has(type)) {
			return;
		}

		const buffer = await response.arrayBuffer();

		if (buffer.byteLength <= 1_048_576) {
			return { buffer, type };
		}
	} catch {
		/* Leave transient failures uncached. */
	}
}

async function loadIcon(domain: string): Promise<Icon | undefined> {
	let icon = icons.get(domain);

	if (!icon) {
		icon = fetchIcon(domain).then((result) => {
			if (!result) {
				icons.delete(domain);
			}

			return result;
		});

		icons.set(domain, icon);
	}

	return icon;
}

export const GET: RequestHandler = async ({ params }) => {
	const name = params.name
		.replace(/\.png$/i, "")
		.toLowerCase()
		.trim();

	if (Object.hasOwn(ENGINE_COLORS, name)) {
		return iconResponse(localMonogram(name), "image/svg+xml; charset=utf-8");
	}

	const base = name.split(/[\s_]/, 1).at(0);
	const engine = Object.hasOwn(ENGINE_DOMAINS, name) ? name : base;

	if (!engine || !Object.hasOwn(ENGINE_DOMAINS, engine)) {
		return new Response("no icon", { status: 404 });
	}

	const icon = await loadIcon(ENGINE_DOMAINS[engine]);

	return icon ? iconResponse(icon.buffer, icon.type) : new Response("no icon", { status: 502 });
};
