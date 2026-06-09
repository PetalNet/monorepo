// Unit tests for the DTCG → daisyUI v5 theme mapping. Pure functions, no I/O,
// run with `node --test tools/*.test.mts` (zero extra deps).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { renderDaisyThemeCss, type TokenMap, toDaisyTheme } from "./daisyui.mts";

// A minimal resolved token map standing in for tokens/dist/index.js (light).
const sample: TokenMap = {
	bg: "#ffffff",
	surface: "#f6f5f3",
	rule: "#ececea",
	text: "#161412",
	petal: "#bc5638",
	"on-petal": "#ffffff",
	"color-petal-hover": "#a14a30",
	success: "#2f8f5b",
	warning: "#c77d11",
	danger: "#c5374b",
	"radius-sm": "0.5rem",
	"radius-md": "0.75rem",
	// status semantic aliases intentionally omitted in dark — exercise fallback:
	"color-status-success": "#2f8f5b",
	"color-status-warning": "#c77d11",
	"color-status-danger": "#c5374b",
};

// daisyUI v5's required theme variables — the contract a theme must satisfy.
const REQUIRED = [
	"color-base-100",
	"color-base-200",
	"color-base-300",
	"color-base-content",
	"color-primary",
	"color-primary-content",
	"color-secondary",
	"color-accent",
	"color-neutral",
	"color-neutral-content",
	"color-info",
	"color-success",
	"color-warning",
	"color-error",
	"radius-selector",
	"radius-field",
	"radius-box",
	"size-selector",
	"size-field",
	"border",
	"depth",
	"noise",
];

test("toDaisyTheme emits every required daisyUI v5 variable", () => {
	const theme = toDaisyTheme(sample);
	for (const key of REQUIRED) {
		assert.ok(key in theme, `missing daisyUI variable: ${key}`);
		assert.match(theme[key], /\S/, `${key} must be non-empty`);
	}
});

test("toDaisyTheme maps our semantic roles to the right daisyUI roles", () => {
	const theme = toDaisyTheme(sample);
	assert.equal(theme["color-base-100"], sample.bg, "base-100 ← bg");
	assert.equal(theme["color-base-200"], sample.surface, "base-200 ← surface");
	assert.equal(theme["color-base-content"], sample.text, "base-content ← text");
	assert.equal(theme["color-primary"], sample.petal, "primary ← petal (THE accent)");
	assert.equal(theme["color-primary-content"], sample["on-petal"], "primary-content ← on-petal");
	assert.equal(theme["color-accent"], sample.petal, "single-accent: accent reuses petal");
	assert.equal(theme["color-success"], "#2f8f5b");
	assert.equal(theme["color-error"], sample.danger, "error ← danger");
	assert.equal(theme["radius-box"], sample["radius-md"], "radius-box ← radius-md (card default)");
	assert.equal(theme["radius-field"], sample["radius-sm"], "radius-field ← radius-sm");
});

test("status colors fall back to primitives when semantic aliases are absent", () => {
	const noAlias: TokenMap = { ...sample };
	delete noAlias.success;
	delete noAlias.warning;
	delete noAlias.danger;
	const theme = toDaisyTheme(noAlias);
	assert.equal(theme["color-success"], "#2f8f5b", "falls back to color-status-success");
	assert.equal(theme["color-warning"], "#c77d11", "falls back to color-status-warning");
	assert.equal(theme["color-error"], "#c5374b", "falls back to color-status-danger");
});

test("toDaisyTheme throws a clear error on a missing required token", () => {
	const broken: TokenMap = { ...sample };
	delete broken.petal;
	assert.throws(() => toDaisyTheme(broken), /missing required key: "petal"/);
});

test("renderDaisyThemeCss produces a valid @plugin block with metadata", () => {
	const css = renderDaisyThemeCss("paper", toDaisyTheme(sample), {
		default: true,
		colorScheme: "light",
	});
	assert.match(css, /@plugin "daisyui\/theme" \{/);
	assert.match(css, /name: "paper";/);
	assert.match(css, /default: true;/);
	assert.match(css, /color-scheme: light;/);
	assert.match(css, /--color-primary: #bc5638;/);
	// Balanced braces — one open, one close.
	assert.equal((css.match(/\{/g) ?? []).length, 1);
	assert.equal((css.match(/\}/g) ?? []).length, 1);
});

test("the BUILT paper theme (dist) emits a valid daisyUI block", async () => {
	// Integration check against the actual generated artifact, if present.
	const root = path.resolve(import.meta.dirname, "..");
	let css: string;
	try {
		css = await readFile(path.join(root, "dist/daisyui.paper.css"), "utf8");
	} catch {
		// dist not built in this environment — the unit tests above still cover
		// the mapping; skip the integration assertion rather than fail.
		return;
	}
	assert.match(css, /@plugin "daisyui\/theme"/);
	assert.match(css, /name: "paper"/);
	for (const key of REQUIRED) assert.match(css, new RegExp(`--${key}:`), `dist missing --${key}`);
});
