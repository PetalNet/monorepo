// Live, theme-aware swatch + tile rebuild — ported from the source page's
// renderSwatches()/renderTiles(). Progressive enhancement: the page SSR-renders
// the LIGHT swatches/tiles into markup (present at first paint, zero CLS); once
// hydrated we rebuild from getComputedStyle ONLY on an actual theme change (and
// on a dark first-paint), mirroring the source's skipBuild logic. Swatch/tile
// COUNT + geometry are identical across themes, so a rebuild changes colors
// only — never height.

import { browser } from "$app/environment";

import type { Swatch, Tile } from "./data";
import { SWATCHES, SWATCH_TOKENS, TILES } from "./data";
import { iconDataUri } from "./tile-icons";

const h = (n: string) => (+n).toString(16).padStart(2, "0");

function toHex(c: string): string {
	c = c.trim();
	if (c[0] === "#") return c.toUpperCase();
	const m = c.match(/rgba?\(([^)]+)\)/);
	if (!m) return c;
	const p = m[1].split(/[,\s/]+/).filter(Boolean);
	let hex = "#" + (h(p[0]) + h(p[1]) + h(p[2])).toUpperCase();
	if (p[3] !== undefined && +p[3] < 1) hex += " · " + Math.round(+p[3] * 100) + "%";
	return hex;
}

/** Build the swatch list from the live computed theme (matches renderSwatches). */
export function liveSwatches(): Swatch[] {
	if (!browser) return SWATCHES;
	const cs = getComputedStyle(document.documentElement);
	return SWATCH_TOKENS.map(([varName, role]) => {
		const raw = cs.getPropertyValue(varName).trim();
		const ring = varName === "--bg" || varName === "--elev";
		return {
			cls: "",
			name: varName,
			hex: toHex(raw) + " · " + role,
			ring,
			rawBg: raw,
		} as Swatch;
	});
}

/** Build the tile list with the live accent stroke (matches renderTiles). */
export function liveTiles(): Tile[] {
	if (!browser) return TILES;
	const stroke =
		getComputedStyle(document.documentElement).getPropertyValue("--petal").trim() || "#bc5638";
	return TILES.map((t) => ({ ...t, iconSvg: iconDataUri(t.icon, stroke) }));
}
