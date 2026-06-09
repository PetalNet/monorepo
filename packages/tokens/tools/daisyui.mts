// Map our DTCG semantic tokens → a daisyUI v5 theme.
//
// daisyUI v5 themes are a flat set of CSS custom properties consumed by the
// `@plugin "daisyui/theme"` block: the color roles (--color-primary,
// --color-base-100, …, each with a *-content pair), plus the radius / size /
// border / effect knobs (--radius-box, --radius-field, --radius-selector,
// --size-field, --size-selector, --border, --depth, --noise).
//
// Our design system has ONE accent (--petal), a paper/ink base ramp, three
// status colors, and a 5-step radius scale. That maps cleanly:
//
//   daisyUI role            ← our token
//   ─────────────────────────────────────────────────
//   base-100 (page)         ← bg
//   base-200 (raised)       ← surface
//   base-300 (rule/border)  ← rule
//   base-content (ink)      ← text
//   primary                 ← petal           (THE accent)
//   primary-content         ← on-petal
//   secondary               ← petal-hover     (the derived darker accent)
//   accent                  ← petal           (single-accent system: reuse)
//   neutral                 ← text            (ink as the neutral fill)
//   neutral-content         ← bg
//   info                    ← petal           (no dedicated info hue; accent)
//   success                 ← success
//   warning                 ← warning
//   error                   ← danger
//   radius-selector         ← radius-sm       (chips/toggles/small controls)
//   radius-field            ← radius-sm       (inputs/buttons)
//   radius-box              ← radius-md        (cards — the default radius)
//
// This module is pure data-in / string-out so it's trivially unit-testable; the
// build step (build.mts) feeds it the already-resolved token map from the
// style-dictionary graph and writes the files.

/** The flat, resolved token map shape that tokens/dist/index.js exports. */
export type TokenMap = Record<string, string | readonly string[]>;

/** A daisyUI v5 theme: flat CSS-var name (without leading `--`) → value. */
export type DaisyTheme = Record<string, string>;

/**
 * `*-content` colors (text/icon drawn ON a filled role) read directly off semantic tokens where we
 * have them; otherwise pick the theme's page bg vs ink so the pair always has contrast. on-petal is
 * authored per-theme.
 */
function pick(tokens: TokenMap, key: string): string {
	const v = tokens[key];
	if (v === undefined) throw new Error(`tokens map is missing required key: "${key}"`);
	if (Array.isArray(v)) return v.join(", ");
	return v as string;
}

/**
 * Like {@link pick} but tries each key in order. Status colors live as semantic aliases (`success`,
 * `warning`, `danger`) only in the light layer — both themes share them — so we fall back to the
 * always-present primitive (`color-status-*`). First key that exists wins.
 */
function pickAny(tokens: TokenMap, ...keys: string[]): string {
	for (const k of keys) if (tokens[k] !== undefined) return pick(tokens, k);
	throw new Error(`tokens map is missing all of: ${keys.map((k) => `"${k}"`).join(", ")}`);
}

/**
 * Build the daisyUI v5 theme variable object from a resolved token map.
 *
 * The token map must already be the per-theme resolved leaves (the semantic roles `bg`, `surface`,
 * `rule`, `text`, `petal`, `on-petal`, `success`, `warning`, `danger`) plus the shared `radius-*`
 * primitives — i.e. exactly what tokens/dist/index.js exports for one theme.
 */
export function toDaisyTheme(tokens: TokenMap): DaisyTheme {
	const petal = pick(tokens, "petal");
	const onPetal = pick(tokens, "on-petal");
	const bg = pick(tokens, "bg");
	const text = pick(tokens, "text");

	return {
		// ── Base ramp ──────────────────────────────────────────────────────
		"color-base-100": bg,
		"color-base-200": pick(tokens, "surface"),
		"color-base-300": pick(tokens, "rule"),
		"color-base-content": text,

		// ── Accent (single-accent system: primary == accent == info) ────────
		"color-primary": petal,
		"color-primary-content": onPetal,
		"color-secondary": pick(tokens, "color-petal-hover"),
		"color-secondary-content": onPetal,
		"color-accent": petal,
		"color-accent-content": onPetal,

		// ── Neutral (ink as the solid neutral fill) ─────────────────────────
		"color-neutral": text,
		"color-neutral-content": bg,

		// ── Status ──────────────────────────────────────────────────────────
		"color-info": petal,
		"color-info-content": onPetal,
		"color-success": pickAny(tokens, "success", "color-status-success"),
		"color-success-content": onPetal,
		"color-warning": pickAny(tokens, "warning", "color-status-warning"),
		"color-warning-content": onPetal,
		"color-error": pickAny(tokens, "danger", "color-status-danger"),
		"color-error-content": onPetal,

		// ── Geometry / effects ──────────────────────────────────────────────
		"radius-selector": pick(tokens, "radius-sm"),
		"radius-field": pick(tokens, "radius-sm"),
		"radius-box": pick(tokens, "radius-md"),
		"size-selector": "0.25rem",
		"size-field": "0.25rem",
		// We draw 1px hairline rules, not heavy chrome — keep daisyUI borders thin.
		border: "1px",
		// Flat by design ("quiet by default"): no faux depth, no noise overlay.
		depth: "0",
		noise: "0",
	};
}

/**
 * Render a daisyUI v5 `@plugin "daisyui/theme"` CSS block for one theme.
 *
 * @param name The daisyUI theme name (e.g. "paper", "ink")
 * @param theme The variable map from {@link toDaisyTheme}
 * @param opts.default Whether this is the daisyUI `default: true` theme
 * @param opts.prefersdark Whether this is the `prefersdark: true` theme
 * @param opts.colorScheme The CSS `color-scheme` (light|dark)
 */
export function renderDaisyThemeCss(
	name: string,
	theme: DaisyTheme,
	opts: { default?: boolean; prefersdark?: boolean; colorScheme: "light" | "dark" },
): string {
	const head = [
		`  name: "${name}";`,
		`  default: ${opts.default ? "true" : "false"};`,
		`  prefersdark: ${opts.prefersdark ? "true" : "false"};`,
		`  color-scheme: ${opts.colorScheme};`,
	];
	const vars = Object.entries(theme).map(([k, v]) => `  --${k}: ${v};`);
	return `@plugin "daisyui/theme" {\n${head.join("\n")}\n\n${vars.join("\n")}\n}\n`;
}
