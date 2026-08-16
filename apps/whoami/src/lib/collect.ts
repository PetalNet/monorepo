// Client-side fingerprint signal collector.
//
// This is the INVERSION of a normal fingerprinter. A tracker reads these signals
// silently and asks "how unique are you". This reads the same signals out loud and
// scores each on TWO axes:
//
//   entropy       — how much this value narrows you down (bits, dataset-relative)
//   reproducibility — is the value re-derivable and stable (so it LINKS you over
//                     time / across sites), or randomized/volatile (high apparent
//                     entropy that burns per session and does NOT track you)
//
// The dangerous quadrant is high-entropy + stable. High-entropy + randomized
// (Brave farbling, RFP canvas) looks scary but is fine for cross-session linkage.
// Standardized-to-common (RFP UA/timezone, hardwareConcurrency=2) is low entropy
// BY DESIGN — that's blending in, the good outcome.
//
// Nothing is sent anywhere and nothing is stored — collection runs in the browser
// and stays in the browser. Every probe is wrapped so one failure never blanks the
// report, and the module is import-safe on the server (guards `typeof window`).

export type SignalCategory =
	| "navigator"
	| "screen"
	| "locale-time"
	| "hardware"
	| "canvas"
	| "webgl"
	| "audio"
	| "features"
	| "network";

/** The reproducibility axis — how a value behaves across requests/sessions/sites. */
export type Repro =
	| "stable" // deterministic, re-derivable from the machine, survives cache clears — LINKS you
	| "randomized" // per-session/per-site noise (farbling, RFP) — high apparent entropy, does NOT link
	| "standardized" // forced to a shared common value (RFP) — low entropy by design, blends in
	| "volatile"; // changes on its own over time (network, IP) — poor linker

export interface Signal {
	/** Stable id, e.g. "navigator.userAgent" */
	id: string;
	label: string;
	category: SignalCategory;
	/** The value a site reads, stringified for display */
	value: string;
	/** The common / default value, for deviation-from-default display */
	typical: string;
	/** Plain-language note: what this reveals and how to read it */
	note: string;
	/** Rough entropy in bits — dataset-relative, for RANK ordering not precise math */
	entropy: number;
	reproducibility: Repro;
	/** True when this signal feeds the cross-site linkability hash (stable + identifying) */
	linking?: boolean;
}

const NA = "(unavailable)";

function str(v: unknown): string {
	if (v === null || v === undefined) return NA;
	if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty)";
	if (typeof v === "object") {
		try {
			return JSON.stringify(v);
		} catch {
			return Object.prototype.toString.call(v);
		}
	}
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
	if (typeof v === "symbol") return v.toString();
	if (typeof v === "function") return String(v);
	return NA;
}

function safe(fn: () => unknown): string {
	try {
		return str(fn());
	} catch {
		return NA;
	}
}

/** A short, stable FNV-1a hash of a string — for canvas/webgl/audio digests and the linkability id. */
function digest(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function canvasDigest(): string {
	const c = document.createElement("canvas");
	c.width = 240;
	c.height = 60;
	const ctx = c.getContext("2d");
	if (!ctx) return NA;
	ctx.textBaseline = "top";
	ctx.font = "14px 'Arial'";
	ctx.fillStyle = "#f60";
	ctx.fillRect(10, 10, 100, 30);
	ctx.fillStyle = "#069";
	ctx.fillText("whoami \u{1F441} fingerprint", 12, 14);
	ctx.strokeStyle = "rgba(0,120,255,0.7)";
	ctx.arc(50, 30, 20, 0, Math.PI * 2);
	ctx.stroke();
	return digest(c.toDataURL());
}

function webglInfo(): { renderer: string; vendor: string; digest: string } {
	const c = document.createElement("canvas");
	const gl = (c.getContext("webgl") ??
		c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
	if (!gl) return { renderer: NA, vendor: NA, digest: NA };
	const dbg = gl.getExtension("WEBGL_debug_renderer_info");
	const renderer = dbg ? str(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "(masked)";
	const vendor = dbg ? str(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : "(masked)";
	const params = [
		gl.getParameter(gl.MAX_TEXTURE_SIZE),
		gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
		gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
		gl.getParameter(gl.MAX_VARYING_VECTORS),
		gl.getSupportedExtensions()?.length ?? 0,
	].join("|");
	return { renderer, vendor, digest: digest(renderer + "|" + vendor + "|" + params) };
}

async function audioDigest(): Promise<string> {
	try {
		const Ctx =
			(window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
				.OfflineAudioContext ??
			(window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
				.webkitOfflineAudioContext;
		if (!Ctx) return NA;
		const ctx = new Ctx(1, 44100, 44100);
		const osc = ctx.createOscillator();
		osc.type = "triangle";
		osc.frequency.value = 10000;
		const comp = ctx.createDynamicsCompressor();
		osc.connect(comp);
		comp.connect(ctx.destination);
		osc.start(0);
		const buf = await ctx.startRendering();
		const data = buf.getChannelData(0).slice(4500, 4600);
		let acc = 0;
		for (const v of data) acc += Math.abs(v);
		return digest(acc.toString());
	} catch {
		return NA;
	}
}

function timezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || NA;
	} catch {
		return NA;
	}
}

/**
 * Collect every signal. Async because audio rendering is async. Returns [] on the server so the
 * module is import-safe.
 */
export async function collectSignals(): Promise<Signal[]> {
	if (typeof window === "undefined" || typeof navigator === "undefined") return [];

	const n = navigator;
	const s = screen;
	const wgl = webglInfo();
	const tz = timezone();
	const isUtc = tz === "UTC" || tz === "Etc/UTC";
	const hc = n.hardwareConcurrency;
	const dpr = window.devicePixelRatio;
	const dprFractional = typeof dpr === "number" && dpr % 1 !== 0;

	const out: Signal[] = [
		// navigator / UA
		{
			id: "navigator.userAgent",
			label: "User agent",
			category: "navigator",
			value: safe(() => n.userAgent),
			typical: "a common browser/OS build string",
			note: "Browser, version, and OS in one string, sent on every request. One of the two heaviest signals — but everyone leaks their OS, so the OS part isn't worth hiding; the exact build+version is.",
			entropy: 8,
			reproducibility: "stable",
			linking: true,
		},
		{
			id: "navigator.platform",
			label: "Platform",
			category: "navigator",
			value: safe(() => n.platform),
			typical: "Win32 / MacIntel / Linux x86_64",
			note: "Your OS family. Should agree with the user agent — a mismatch is a spoofing tell, not entropy.",
			entropy: 2,
			reproducibility: "stable",
		},
		{
			id: "navigator.vendor",
			label: "Vendor",
			category: "navigator",
			value: safe(() => n.vendor),
			typical: '"Google Inc." (Chromium) / "" (Firefox)',
			note: "Engine vendor. Empty on Firefox, set on Chromium — pairs with the UA as a consistency check.",
			entropy: 1,
			reproducibility: "stable",
		},
		{
			id: "navigator.webdriver",
			label: "Automation flag",
			category: "navigator",
			value: safe(() => n.webdriver),
			typical: "false",
			note: "True only under automation. For humans it's false; a forced non-default is itself unusual.",
			entropy: 1,
			reproducibility: "stable",
		},
		{
			id: "navigator.doNotTrack",
			label: "Do Not Track",
			category: "navigator",
			value: safe(() => n.doNotTrack),
			typical: "null (unset)",
			note: "Ironically a bit of entropy — few people set it, so setting it can mark you rather than protect you.",
			entropy: 1,
			reproducibility: "stable",
		},
		// locale / time
		{
			id: "navigator.language",
			label: "Language",
			category: "locale-time",
			value: safe(() => n.language),
			typical: "en-US",
			note: "Primary language, also sent as Accept-Language. Identifying for non-dominant locales.",
			entropy: 2,
			reproducibility: "stable",
			linking: true,
		},
		{
			id: "navigator.languages",
			label: "Language list",
			category: "locale-time",
			value: safe(() => n.languages.slice(0, 6)),
			typical: '["en-US","en"]',
			note: "Ordered language preferences. A long custom list is high entropy; Safari/incognito trim it to one to blend in.",
			entropy: 3,
			reproducibility: "stable",
		},
		{
			id: "intl.timeZone",
			label: "Time zone",
			category: "locale-time",
			value: tz,
			typical: "your regional IANA zone",
			note: isUtc
				? "UTC — this is RFP forcing everyone to the same zone. Blending in."
				: "Your IANA zone geolocates you to a region. RFP forces UTC for everyone. Check it against your IP country below.",
			entropy: isUtc ? 0 : 3,
			reproducibility: isUtc ? "standardized" : "stable",
			linking: !isUtc,
		},
		{
			id: "intl.timeZoneOffset",
			label: "UTC offset (min)",
			category: "locale-time",
			value: safe(() => new Date().getTimezoneOffset()),
			typical: "matches your zone",
			note: "Minutes from UTC. Coarser than the zone name but still regional.",
			entropy: 1,
			reproducibility: "stable",
		},
		// screen / display
		{
			id: "screen.resolution",
			label: "Screen resolution",
			category: "screen",
			value: safe(() => `${String(s.width)}x${String(s.height)}`),
			typical: "1920x1080",
			note: "Monitor size. Common sizes blend in; an odd or rounded size is an RFP/letterbox tell. These values already fold in your pixel ratio.",
			entropy: 4,
			reproducibility: "stable",
			linking: true,
		},
		{
			id: "screen.avail",
			label: "Available screen",
			category: "screen",
			value: safe(() => `${String(s.availWidth)}x${String(s.availHeight)}`),
			typical: "resolution minus the taskbar",
			note: "Screen minus OS chrome — leaks taskbar/dock size and position.",
			entropy: 2,
			reproducibility: "stable",
		},
		{
			id: "window.inner",
			label: "Window inner size",
			category: "screen",
			value: safe(() => `${String(window.innerWidth)}x${String(window.innerHeight)}`),
			typical: "your window size",
			note: "Your exact window size. RFP letterboxes this to shared 200x100 steps so everyone lands on the same few values.",
			entropy: 2,
			reproducibility: "stable",
		},
		{
			id: "screen.colorDepth",
			label: "Color depth",
			category: "screen",
			value: safe(() => s.colorDepth),
			typical: "24",
			note: "Bits per pixel. Almost always 24 — in the crowd. HDR displays may report 30.",
			entropy: 0.3,
			reproducibility: "stable",
		},
		{
			id: "window.devicePixelRatio",
			label: "Device pixel ratio",
			category: "screen",
			value: safe(() => dpr),
			typical: "1, 2, or 3",
			note: dprFractional
				? "A fractional ratio (1.25 / 1.5 / 1.75) strongly implies Windows display scaling. Maps back to a default step, so it's not as unique as it looks — but it must agree with your platform."
				: "Display scaling. 1 or 2 is desktop/Mac, 3 is a modern phone. Page zoom folds in here too, so it isn't pure hardware.",
			entropy: 1.5,
			reproducibility: "stable",
		},
		{
			id: "css.prefersColorScheme",
			label: "Color scheme",
			category: "screen",
			value: safe(() => {
				const mm = (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
				return mm?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
			}),
			typical: "dark or light",
			note: "Your light/dark preference — one bit, but it adds to the pile.",
			entropy: 1,
			reproducibility: "stable",
		},
		{
			id: "css.prefersReducedMotion",
			label: "Reduced motion",
			category: "screen",
			value: safe(() => {
				const mm = (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
				return mm?.("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference";
			}),
			typical: "no-preference",
			note: "Accessibility preference exposed to sites — one bit.",
			entropy: 1,
			reproducibility: "stable",
		},
		// hardware
		{
			id: "navigator.hardwareConcurrency",
			label: "CPU cores",
			category: "hardware",
			value: safe(() => hc),
			typical: "4, 8, or 16",
			note:
				hc === 2
					? "Exactly 2 — Tor/RFP caps everyone here. The value blends in, but 2 on an otherwise-modern browser is itself an RFP tell."
					: "Logical core count. RFP forces 2 for everyone; a real modern number is moderate entropy.",
			entropy: hc === 2 ? 0.3 : 2,
			reproducibility: hc === 2 ? "standardized" : "stable",
		},
		{
			id: "navigator.deviceMemory",
			label: "Device memory (GB)",
			category: "hardware",
			value: safe(() => (n as unknown as { deviceMemory?: number }).deviceMemory),
			typical: "8 (present only on Chromium)",
			note: "Coarse RAM bucket, clamped to 0.25–8. Chromium-only — its very presence says Chromium, so seeing it under a Firefox UA is a spoof tell.",
			entropy: 1.5,
			reproducibility: "stable",
		},
		{
			id: "navigator.maxTouchPoints",
			label: "Max touch points",
			category: "hardware",
			value: safe(() => n.maxTouchPoints),
			typical: "0 desktop / 5 phone",
			note: "Touch support. Must agree with your platform — >0 under a desktop UA (or 0 under a mobile UA) is a contradiction.",
			entropy: 1,
			reproducibility: "stable",
		},
		// canvas / webgl / audio
		{
			id: "canvas.digest",
			label: "Canvas fingerprint",
			category: "canvas",
			value: canvasDigest(),
			typical: "varies by GPU/driver/fonts",
			note: "A hash of how your stack renders a test image. In default Chrome/Safari it's a top-tier, stable identifier. Brave and RFP randomise it per site — high apparent entropy, but then it can't link you across sites. Use the linkability test to see which you have.",
			entropy: 8,
			reproducibility: "stable",
			linking: true,
		},
		{
			id: "webgl.renderer",
			label: "GPU renderer",
			category: "webgl",
			value: wgl.renderer,
			typical: "(masked) under RFP",
			note: "Your exact GPU model string, and the fastest-rising stable hardware signal. Re-derivable from the machine, survives cache clears. (masked) means RFP is hiding it — good.",
			entropy: 5,
			reproducibility: wgl.renderer === "(masked)" ? "standardized" : "stable",
			linking: wgl.renderer !== "(masked)",
		},
		{
			id: "webgl.vendor",
			label: "GPU vendor",
			category: "webgl",
			value: wgl.vendor,
			typical: "(masked) under RFP",
			note: "GPU vendor. Pairs with the renderer.",
			entropy: 2,
			reproducibility: "stable",
		},
		{
			id: "webgl.digest",
			label: "WebGL param digest",
			category: "webgl",
			value: wgl.digest,
			typical: "varies by driver",
			note: "Hash of WebGL limits and extensions — hardware and driver specific.",
			entropy: 2,
			reproducibility: "stable",
		},
		{
			id: "audio.digest",
			label: "Audio fingerprint",
			category: "audio",
			value: "(computing…)",
			typical: "varies by audio stack",
			note: "A hash of tiny floating-point differences in your audio stack. Stable and hardware-specific by default; RFP and Brave neutralise it.",
			entropy: 3,
			reproducibility: "stable",
		},
		// features / storage
		{
			id: "features.cookiesEnabled",
			label: "Cookies enabled",
			category: "features",
			value: safe(() => n.cookieEnabled),
			typical: "true",
			note: "Whether cookies are on. Low entropy.",
			entropy: 0.2,
			reproducibility: "stable",
		},
		{
			id: "features.storage",
			label: "Local storage",
			category: "features",
			value: safe(() => (typeof localStorage !== "undefined" ? "available" : "blocked")),
			typical: "available",
			note: "Storage availability — disabling it entirely is rare and therefore distinctive.",
			entropy: 1,
			reproducibility: "stable",
		},
		{
			id: "features.pdfViewer",
			label: "PDF viewer",
			category: "features",
			value: safe(() => n.pdfViewerEnabled),
			typical: "true",
			note: "Built-in PDF viewer flag — a small bit.",
			entropy: 0.3,
			reproducibility: "stable",
		},
		// network
		{
			id: "network.effectiveType",
			label: "Connection type",
			category: "network",
			value: safe(
				() =>
					(n as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType,
			),
			typical: "4g",
			note: "Coarse connection-speed bucket. Changes as your network changes, so it's a weak, volatile signal.",
			entropy: 1,
			reproducibility: "volatile",
		},
	];

	// audio is async — fill it in after the synchronous signals so the UI can render immediately
	const audio = await audioDigest();
	const audioSig = out.find((x) => x.id === "audio.digest");
	if (audioSig) audioSig.value = audio;

	return out;
}

/**
 * The cross-site linkability hash: a digest of ONLY the stable, identifying signals (the ones
 * flagged `linking`). This is what a tracker would use to recognise you on a return visit or on
 * another site. Randomized/volatile signals are excluded on purpose — they can't link you, so
 * folding them in would overstate the risk.
 *
 * If this hash is identical across incognito, containers, or a VPN switch, those measures did NOT
 * stop cross-visit tracking. If it differs on a second registrable domain, farbling or
 * state-partitioning is breaking the cross-site link.
 */
export function linkabilityHash(signals: Signal[]): string {
	const parts = signals
		.filter((sig) => sig.linking && sig.value && sig.value !== NA)
		.map((sig) => `${sig.id}=${sig.value}`);
	return digest(parts.join(""));
}

export const CATEGORY_LABELS: Record<SignalCategory, string> = {
	navigator: "browser & agent",
	screen: "screen & window",
	"locale-time": "language & time",
	hardware: "hardware",
	canvas: "canvas",
	webgl: "gpu / webgl",
	audio: "audio",
	features: "features",
	network: "network",
};
