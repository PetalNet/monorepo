// Static content for the design-system page, mirroring the source page's
// server-rendered markup exactly. These drive the {#each} loops in +page.svelte
// so they render at first paint (SSR) — the live theme-aware swatch/tile rebuild
// is a progressive enhancement layered on top in the browser.

export interface Swatch {
	cls: string; // chip background utility class (chip-bg-*); "" when rawBg is set
	name: string; // CSS var name shown in mono
	hex: string; // descriptive hex/value text
	ring?: boolean; // light chips get a ring outline
	rawBg?: string; // live computed color (set by the client rebuild); overrides cls
}

export const SWATCHES: Swatch[] = [
	{ cls: "chip-bg-bg", name: "--bg", hex: "#FFFFFF · paper", ring: true },
	{ cls: "chip-bg-surface", name: "--surface", hex: "#F6F5F3 · filled cards" },
	{ cls: "chip-bg-elev", name: "--elev", hex: "#FBFAF9 · hover surface", ring: true },
	{ cls: "chip-bg-rule", name: "--rule", hex: "#ECECEA · hairline rules" },
	{ cls: "chip-bg-rule-strong", name: "--rule-strong", hex: "#D9D7D3 · outlined edge" },
	{ cls: "chip-bg-text", name: "--text", hex: "#161412 · ink" },
	{ cls: "chip-bg-text-mute", name: "--text-mute", hex: "#645F59 · secondary" },
	{ cls: "chip-bg-text-soft", name: "--text-soft", hex: "#97928B · tertiary" },
	{ cls: "chip-bg-petal", name: "--petal", hex: "#BC5638 · the accent" },
	{
		cls: "chip-bg-petal-soft",
		name: "--petal-soft",
		hex: "color-mix(in srgb, #bc5638 11%, transparent) · state layer",
	},
	{ cls: "chip-bg-success", name: "--success", hex: "#2F8F5B · status only" },
	{ cls: "chip-bg-warning", name: "--warning", hex: "#C77D11 · status only" },
	{ cls: "chip-bg-danger", name: "--danger", hex: "#C5374B · status only" },
];

// Live read order for the JS-enhanced swatch rebuild (token var + role label).
export const SWATCH_TOKENS: [string, string][] = [
	["--bg", "paper"],
	["--surface", "filled cards"],
	["--elev", "hover surface"],
	["--rule", "hairline rules"],
	["--rule-strong", "outlined edge"],
	["--text", "ink"],
	["--text-mute", "secondary"],
	["--text-soft", "tertiary"],
	["--petal", "the accent"],
	["--petal-soft", "state layer"],
	["--success", "status only"],
	["--warning", "status only"],
	["--danger", "status only"],
];

export interface Tile {
	name: string;
	tag: string;
	icon: string; // lucide name for iconDataUri
	iconSvg: string; // inlined data-uri src (light accent) for first paint
	warn?: boolean;
}

// data: SVG src, stroke=#bc5638 (the light accent), matching the source markup.
const TILE_ICON = (paths: string) => `data:image/svg+xml;utf8,${paths}`;

export const TILES: Tile[] = [
	{
		name: "Photos",
		tag: "Every photo and video, in one place.",
		icon: "image",
		iconSvg: TILE_ICON(
			`%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'%23bc5638'%20stroke-width%3D'2'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Crect%20width%3D'18'%20height%3D'18'%20x%3D'3'%20y%3D'3'%20rx%3D'2'%20ry%3D'2'%2F%3E%3Ccircle%20cx%3D'9'%20cy%3D'9'%20r%3D'2'%2F%3E%3Cpath%20d%3D'm21%2015-3.086-3.086a2%202%200%200%200-2.828%200L6%2021'%2F%3E%3C%2Fsvg%3E`,
		),
	},
	{
		name: "Passwords",
		tag: "Your logins, kept safe.",
		icon: "lock",
		iconSvg: TILE_ICON(
			`%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'%23bc5638'%20stroke-width%3D'2'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Crect%20width%3D'18'%20height%3D'11'%20x%3D'3'%20y%3D'11'%20rx%3D'2'%20ry%3D'2'%2F%3E%3Cpath%20d%3D'M7%2011V7a5%205%200%200%201%2010%200v4'%2F%3E%3C%2Fsvg%3E`,
		),
	},
	{
		name: "VPN access",
		tag: "A private door home.",
		icon: "shield-check",
		iconSvg: TILE_ICON(
			`%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'%23bc5638'%20stroke-width%3D'2'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Cpath%20d%3D'M20%2013c0%205-3.5%207.5-7.66%208.95a1%201%200%200%201-.67-.01C7.5%2020.5%204%2018%204%2013V6a1%201%200%200%201%201-1c2%200%204.5-1.2%206.24-2.72a1.17%201.17%200%200%201%201.52%200C14.51%203.81%2017%205%2019%205a1%201%200%200%201%201%201z'%2F%3E%3Cpath%20d%3D'm9%2012%202%202%204-4'%2F%3E%3C%2Fsvg%3E`,
		),
	},
	{
		name: "Tasks",
		tag: "What needs doing.",
		icon: "list-todo",
		warn: true,
		iconSvg: TILE_ICON(
			`%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'%23bc5638'%20stroke-width%3D'2'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Cpath%20d%3D'M13%205h8'%2F%3E%3Cpath%20d%3D'M13%2012h8'%2F%3E%3Cpath%20d%3D'M13%2019h8'%2F%3E%3Cpath%20d%3D'm3%2017%202%202%204-4'%2F%3E%3Crect%20x%3D'3'%20y%3D'4'%20width%3D'6'%20height%3D'6'%20rx%3D'1'%2F%3E%3C%2Fsvg%3E`,
		),
	},
];

export interface SpaceRow {
	lbl: string;
	bar: string; // space-bar-* width utility class
	use: string;
}
export const SPACES: SpaceRow[] = [
	{ lbl: "4 px", bar: "space-bar-16", use: "tight pairs" },
	{ lbl: "8 px", bar: "space-bar-32", use: "within a block" },
	{ lbl: "16 px", bar: "space-bar-64", use: "block to block" },
	{ lbl: "24 px", bar: "space-bar-96", use: "page padding · desktop" },
	{ lbl: "32 px", bar: "space-bar-128", use: "major gaps" },
	{ lbl: "48 px", bar: "space-bar-192", use: "between sections" },
	{ lbl: "64 px", bar: "space-bar-256", use: "page top" },
];

export interface TypeRow {
	spec: string; // may contain a <br>
	sampleCls: string; // s-* class on the sample span
	mono?: boolean;
	sample: string;
}
export const TYPE_ROWS: TypeRow[] = [
	{
		spec: "11px · 500<br>mono · upper",
		sampleCls: "s-micro mono",
		mono: true,
		sample: "Lab status · 14d",
	},
	{
		spec: "12px · 400<br>caption",
		sampleCls: "s-small",
		sample: "Movies, shows, and music, all in one place.",
	},
	{
		spec: "14px · 400<br>body",
		sampleCls: "s-body",
		sample: "Surfaces are calm. Type does the talking; we don't lean on illustration or chrome.",
	},
	{ spec: "13.5px · 500<br>card title", sampleCls: "s-card", sample: "Up next" },
	{ spec: "14px · 500<br>section head", sampleCls: "s-head", sample: "Open questions" },
	{ spec: "14px · 400<br>hero subline", sampleCls: "s-subln", sample: "A friendly back office." },
	{ spec: "32px · 500<br>hero", sampleCls: "s-hero", sample: "Good morning, Parker." },
];

export interface TokenRow {
	name: string;
	val: string;
	use: string;
	curve: string; // curve-* class
}
export const MOTION_TOKENS: TokenRow[] = [
	{ name: "--dur-fast", val: "120ms", use: "press, tiny hovers", curve: "curve-120-std" },
	{ name: "--dur-base", val: "160ms", use: "hover, focus, color", curve: "curve-160-std" },
	{ name: "--dur-mid", val: "240ms", use: "small entrances, popovers", curve: "curve-240-in" },
	{ name: "--dur-slow", val: "360ms", use: "longest, large transitions", curve: "curve-360-in" },
	{
		name: "--ease-standard",
		val: "cubic-bezier(.2,0,0,1)",
		use: "ordinary state changes",
		curve: "curve-360-std",
	},
	{
		name: "--ease-emph-in",
		val: "cubic-bezier(.05,.7,.1,1)",
		use: "enters (decelerate)",
		curve: "curve-360-in",
	},
	{
		name: "--ease-emph-out",
		val: "cubic-bezier(.3,0,.8,.15)",
		use: "exits (accelerate)",
		curve: "curve-360-out",
	},
];

export interface A11yItem {
	title: string;
	desc: string;
}
export const A11Y: A11yItem[] = [
	{
		title: "Visible focus rings.",
		desc: "2px accent, 2px offset on focus-visible. Tab through to see it.",
	},
	{ title: "Generous tap targets.", desc: "At least 32px; 40px for primary actions." },
	{ title: "Keyboard everywhere.", desc: "Every control is reachable and operable." },
	{
		title: "Reasonable AA contrast.",
		desc: "Text and the theme-aware accent measure to AA on both surfaces. Not AAA everywhere.",
	},
	{
		title: "Reduced motion honored.",
		desc: "As a real branch in the code, not just a CSS speed-up.",
	},
	{
		title: "System theme respected.",
		desc: "First visit follows the OS; your choice persists after.",
	},
];

// ProseMark seed document (source line = one paragraph, see source page note).
export const PM_SEED = [
	"# Welcome to ProseMark",
	"",
	"A **WYSIWYM** markdown editor, themed to the PetalNet spec. The text reads like the rendered result while you type.",
	"",
	"## Try it",
	"",
	"- Edit any of this text directly",
	"- Use `**bold**`, `*italic*`, or inline `code`",
	"- Links use the accent, like [the spec](https://prosemark.com/)",
	"",
	"> Idle is silent. Motion rewards a change.",
	"",
	"```js",
	"function greet(name) {",
	"  return `Good morning, ${name}.`;",
	"}",
	"```",
	"",
	"Code uses Geist Mono. Everything else is Geist. One accent.",
	"",
].join("\n");
