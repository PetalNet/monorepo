// Client-side fingerprint signal collector.
//
// The whole point of this app is the INVERSION of a normal fingerprinter: instead
// of "you are 1 in N", it enumerates every signal a site can read off you, shows
// the value, and says what it leaks. Nothing is sent anywhere and nothing is
// stored — collection runs in the browser and stays in the browser.
//
// Every probe is wrapped so one failure never blanks the whole report, and the
// module is import-safe on the server (guards `typeof window`).

export type SignalCategory =
	| "navigator"
	| "screen"
	| "locale-time"
	| "hardware"
	| "canvas"
	| "webgl"
	| "audio"
	| "fonts"
	| "network"
	| "features";

export interface Signal {
	/** Stable id, e.g. "navigator.userAgent" */
	id: string;
	/** Human label */
	label: string;
	category: SignalCategory;
	/** The value a site reads, stringified for display */
	value: string;
	/** Plain-language note: what this reveals / how identifying it is */
	note: string;
	/** Rough entropy weight, 0 (trivial) .. 3 (strongly identifying) */
	weight: 0 | 1 | 2 | 3;
}

const NA = "(unavailable)";

function str(v: unknown): string {
	if (v === null || v === undefined) return NA;
	if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty)";
	if (typeof v === "object") {
		try {
			return JSON.stringify(v);
		} catch {
			return String(v);
		}
	}
	return String(v);
}

function safe(fn: () => unknown): string {
	try {
		return str(fn());
	} catch {
		return NA;
	}
}

/** A short, stable hash of a string — for canvas/webgl/audio readback digests. */
function digest(input: string): string {
	let h1 = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h1 ^= input.charCodeAt(i);
		h1 = Math.imul(h1, 0x01000193);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0");
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
	const gl = (c.getContext("webgl") ||
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
				.OfflineAudioContext ||
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
	const out: Signal[] = [
		// navigator / UA
		{
			id: "navigator.userAgent",
			label: "User agent",
			category: "navigator",
			value: safe(() => n.userAgent),
			note: "Browser, version, and OS in one string. Sent on every request. High signal unless RFP generalises it.",
			weight: 3,
		},
		{
			id: "navigator.platform",
			label: "Platform",
			category: "navigator",
			value: safe(() => n.platform),
			note: "Your OS family. Should agree with the user agent — a mismatch flags a spoofer.",
			weight: 2,
		},
		{
			id: "navigator.vendor",
			label: "Vendor",
			category: "navigator",
			value: safe(() => n.vendor),
			note: "Engine vendor. Low on its own.",
			weight: 1,
		},
		{
			id: "navigator.webdriver",
			label: "Automation flag",
			category: "navigator",
			value: safe(() => n.webdriver),
			note: "True only under automation. For humans it's false; a forced value is itself unusual.",
			weight: 1,
		},
		{
			id: "navigator.doNotTrack",
			label: "Do Not Track",
			category: "navigator",
			value: safe(() => n.doNotTrack),
			note: "Ironically a bit of entropy — few people set it, so setting it can mark you.",
			weight: 1,
		},
		// locale / time
		{
			id: "navigator.language",
			label: "Language",
			category: "locale-time",
			value: safe(() => n.language),
			note: "Primary language. Sent as Accept-Language too. Identifying for non-English locales.",
			weight: 2,
		},
		{
			id: "navigator.languages",
			label: "Language list",
			category: "locale-time",
			value: safe(() => (n.languages || []).slice(0, 6)),
			note: "Ordered language preferences. A custom list is high entropy.",
			weight: 2,
		},
		{
			id: "intl.timeZone",
			label: "Time zone",
			category: "locale-time",
			value: timezone(),
			note: "Your IANA time zone — geolocates you to a region. RFP forces UTC for everyone.",
			weight: 3,
		},
		{
			id: "intl.timeZoneOffset",
			label: "UTC offset (min)",
			category: "locale-time",
			value: safe(() => new Date().getTimezoneOffset()),
			note: "Minutes from UTC. Coarser than the zone name but still regional.",
			weight: 1,
		},
		// screen / display
		{
			id: "screen.resolution",
			label: "Screen resolution",
			category: "screen",
			value: safe(() => `${s.width}x${s.height}`),
			note: "Monitor size. Combined with window size, strongly identifying.",
			weight: 2,
		},
		{
			id: "screen.avail",
			label: "Available screen",
			category: "screen",
			value: safe(() => `${s.availWidth}x${s.availHeight}`),
			note: "Screen minus OS chrome — leaks taskbar/dock position and size.",
			weight: 2,
		},
		{
			id: "window.inner",
			label: "Window inner size",
			category: "screen",
			value: safe(() => `${window.innerWidth}x${window.innerHeight}`),
			note: "Your exact window size. RFP letterboxing snaps this to shared steps.",
			weight: 2,
		},
		{
			id: "screen.colorDepth",
			label: "Color depth",
			category: "screen",
			value: safe(() => s.colorDepth),
			note: "Bits per pixel. Low entropy — almost always 24.",
			weight: 0,
		},
		{
			id: "window.devicePixelRatio",
			label: "Device pixel ratio",
			category: "screen",
			value: safe(() => window.devicePixelRatio),
			note: "Display scaling. A non-integer custom value is distinctive.",
			weight: 1,
		},
		{
			id: "css.prefersColorScheme",
			label: "Color scheme",
			category: "screen",
			value: safe(() =>
				window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
			),
			note: "Your light/dark preference — one bit, but adds up.",
			weight: 1,
		},
		{
			id: "css.prefersReducedMotion",
			label: "Reduced motion",
			category: "screen",
			value: safe(() =>
				window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
					? "reduce"
					: "no-preference",
			),
			note: "Accessibility preference exposed to sites — one bit.",
			weight: 1,
		},
		// hardware
		{
			id: "navigator.hardwareConcurrency",
			label: "CPU cores",
			category: "hardware",
			value: safe(() => n.hardwareConcurrency),
			note: "Logical core count. RFP forces 2 for everyone; the real number is moderate entropy.",
			weight: 2,
		},
		{
			id: "navigator.deviceMemory",
			label: "Device memory (GB)",
			category: "hardware",
			value: safe(() => (n as unknown as { deviceMemory?: number }).deviceMemory),
			note: "Coarse RAM bucket. Chrome-only; another hardware bit.",
			weight: 1,
		},
		{
			id: "navigator.maxTouchPoints",
			label: "Max touch points",
			category: "hardware",
			value: safe(() => n.maxTouchPoints),
			note: "Touch support — distinguishes phones/tablets/touch laptops from desktops.",
			weight: 2,
		},
		// canvas / webgl / audio
		{
			id: "canvas.digest",
			label: "Canvas fingerprint",
			category: "canvas",
			value: canvasDigest(),
			note: "A hash of how your GPU/driver/fonts render a test image. A top-tier, stable identifier. RFP randomises it per site.",
			weight: 3,
		},
		{
			id: "webgl.renderer",
			label: "GPU renderer",
			category: "webgl",
			value: wgl.renderer,
			note: "Your exact GPU model string. Extremely identifying when unmasked.",
			weight: 3,
		},
		{
			id: "webgl.vendor",
			label: "GPU vendor",
			category: "webgl",
			value: wgl.vendor,
			note: "GPU vendor. Pairs with the renderer.",
			weight: 2,
		},
		{
			id: "webgl.digest",
			label: "WebGL param digest",
			category: "webgl",
			value: wgl.digest,
			note: "Hash of WebGL limits and extensions — hardware/driver specific.",
			weight: 2,
		},
		{
			id: "audio.digest",
			label: "Audio fingerprint",
			category: "audio",
			value: "(computing…)",
			note: "A hash of tiny floating-point differences in your audio stack. Stable and hardware-specific. RFP neutralises it.",
			weight: 3,
		},
		// features / storage
		{
			id: "features.cookiesEnabled",
			label: "Cookies enabled",
			category: "features",
			value: safe(() => n.cookieEnabled),
			note: "Whether cookies are on. Low entropy.",
			weight: 0,
		},
		{
			id: "features.storage",
			label: "Local storage",
			category: "features",
			value: safe(() => (typeof localStorage !== "undefined" ? "available" : "blocked")),
			note: "Storage availability — disabling it entirely is rare and distinctive.",
			weight: 1,
		},
		{
			id: "features.pdfViewer",
			label: "PDF viewer",
			category: "features",
			value: safe(() => n.pdfViewerEnabled),
			note: "Built-in PDF viewer flag — a small bit.",
			weight: 0,
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
			note: "Coarse connection speed bucket. Changes over time, so weak on its own.",
			weight: 1,
		},
	];

	// audio is async — fill it in after the synchronous signals so the UI can render immediately
	const audio = await audioDigest();
	const audioSig = out.find((x) => x.id === "audio.digest");
	if (audioSig) audioSig.value = audio;

	return out;
}

export const CATEGORY_LABELS: Record<SignalCategory, string> = {
	navigator: "Browser & agent",
	screen: "Screen & window",
	"locale-time": "Language & time",
	hardware: "Hardware",
	canvas: "Canvas",
	webgl: "GPU / WebGL",
	audio: "Audio",
	fonts: "Fonts",
	network: "Network",
	features: "Features",
};
