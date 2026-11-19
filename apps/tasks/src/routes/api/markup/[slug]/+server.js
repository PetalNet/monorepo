import { error } from "@sveltejs/kit";

import { getArtifact, getMarkup, saveMarkup } from "#lib/server/db.js";

// The viewer's own pencil ink for one artifact. Same SSO gate as the rest of the app (the
// hooks gate sets locals.user), plus the artifact visibility gate, so you can only ink a page
// you can read. The strokes come from a postMessage out of an author-trusted iframe, so they
// are parsed into the exact stroke shape here rather than stored as handed over.
const MAX_STROKES = 2000;
const MAX_POINTS = 6000;

// See the anchor shape in src/lib/ink.js.
function parseAnchor(a) {
	const offset = (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e6;

	if (
		!a ||
		typeof a.p !== "string" ||
		a.p.length > 400 ||
		!/^(?:#[^\s/]{1,100})?(?:\/\d{1,5})*$/.test(a.p) ||
		!offset(a.dx) ||
		!offset(a.dy) ||
		!Number.isInteger(a.up) ||
		a.up < 0 ||
		a.up > 200
	) {
		return null;
	}

	return { p: a.p, dx: a.dx, dy: a.dy, up: a.up };
}

function parseStrokes(input) {
	if (!Array.isArray(input) || input.length > MAX_STROKES) {
		return null;
	}

	const out = [];

	for (const s of input) {
		if (!s || (s.tool !== "pen" && s.tool !== "hl")) {
			return null;
		}

		if (typeof s.color !== "string" || !/^#[0-9a-f]{6}$/i.test(s.color)) {
			return null;
		}

		const width = Number(s.width);
		const vw = Number(s.vw);

		if (!(width > 0 && width <= 64) || !Number.isInteger(vw) || vw < 1 || vw > 20000) {
			return null;
		}

		const p = s.pts;

		if (!Array.isArray(p) || p.length === 0 || p.length % 3 || p.length > MAX_POINTS * 3) {
			return null;
		}

		const ok = p.every(
			(n, i) =>
				typeof n === "number" &&
				Number.isFinite(n) &&
				(i % 3 === 2 ? n >= 0 && n <= 1 : Math.abs(n) < 1e6),
		);

		if (!ok) {
			return null;
		}

		const stroke = { tool: s.tool, color: s.color.toLowerCase(), width, vw, pts: p };

		// A bad anchor only costs placement, so it is dropped rather than failing the whole save.
		const anchor = s.anchor === undefined ? null : parseAnchor(s.anchor);

		if (anchor) {
			stroke.anchor = anchor;
		}

		out.push(stroke);
	}

	return out;
}

function gate(params, locals) {
	if (!locals.user) {
		throw error(403, "sign in to mark up");
	}

	const a = getArtifact(params.slug, locals.user);

	if (!a || (a.kind !== "html" && a.kind !== "interactive")) {
		throw error(404, "No such artifact");
	}

	return a;
}

export function GET({ params, locals }) {
	const a = gate(params, locals);

	return Response.json(
		getMarkup(a.slug, locals.user) || { author: locals.user, strokes: [], updated_at: null },
	);
}

export async function PUT({ params, locals, request }) {
	const a = gate(params, locals);
	let body;

	try {
		body = await request.json();
	} catch {
		throw error(400, "bad json");
	}

	const strokes = parseStrokes(body?.strokes);

	if (!strokes) {
		throw error(400, "bad strokes");
	}

	const saved = saveMarkup(a.slug, locals.user, strokes);

	return Response.json(saved || { author: locals.user, strokes: [], updated_at: null });
}
