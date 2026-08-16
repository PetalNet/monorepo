// The consistency engine — the thing CoverYourTracks does NOT do.
//
// A tracker doesn't only ask "how unique is this value". Its strongest move is to
// notice when two signals CONTRADICT each other, because a coherent real machine
// cannot emit contradictory signals, and genuine signals are heavily correlated.
// You can be dead-average on every single value and still get flagged the instant
// two axes disagree — TLS says Firefox but the UA says Chrome, the language header
// disagrees with navigator.language, a Chromium-only API shows up under a Firefox UA.
//
// This runs those cross-checks across three surfaces: HTTP headers (server-visible),
// the Cloudflare edge trace (network layer), and the JS environment (client). It
// reports contradictions, not a uniqueness score.

export interface ServerSignals {
	userAgent: string | null;
	acceptLanguage: string | null;
	acceptEncoding: string | null;
	accept: string | null;
	secChUa: string | null;
	secChUaPlatform: string | null;
	secChUaMobile: string | null;
	dnt: string | null;
	cfCountry: string | null;
	cfRay: string | null;
	/** the visitor's own IP, shown back to them; never logged or stored */
	ip: string | null;
}

/** Parsed Cloudflare edge trace (/cdn-cgi/trace), fetched same-origin on the client. */
export interface EdgeTrace {
	warp: string | null; // on | plus | off
	gateway: string | null; // on | off  (Cloudflare Zero Trust)
	loc: string | null; // country code seen by the edge
	tls: string | null; // TLS version
	colo: string | null; // CF datacenter
	ip: string | null;
	rbi: string | null; // remote browser isolation
}

/** The subset of the JS environment the checks compare against. */
export interface ClientView {
	userAgent: string;
	language: string;
	languages: string[];
	platform: string;
	vendor: string;
	deviceMemory: number | undefined;
	maxTouchPoints: number;
	dpr: number;
	timezone: string;
	utcOffsetMin: number;
}

export type Severity = "high" | "medium" | "info";

export interface Contradiction {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
	/** the two (or more) surfaces that disagree, shown as evidence */
	evidence: { label: string; value: string }[];
}

function uaFamily(ua: string): "chromium" | "firefox" | "safari" | "unknown" {
	const u = ua.toLowerCase();
	if (/edg\/|edga\/|edgios\//.test(u)) return "chromium";
	if (/firefox\/|fxios\//.test(u)) return "firefox";
	if (/chrome\/|chromium\/|crios\//.test(u)) return "chromium";
	if (/safari\//.test(u) && !/chrome\//.test(u)) return "safari";
	return "unknown";
}

function uaOs(ua: string): "windows" | "macos" | "linux" | "android" | "ios" | "unknown" {
	const u = ua.toLowerCase();
	if (/windows/.test(u)) return "windows";
	if (/android/.test(u)) return "android";
	if (/iphone|ipad|ipod/.test(u)) return "ios";
	if (/mac os x|macintosh/.test(u)) return "macos";
	if (/linux/.test(u)) return "linux";
	return "unknown";
}

function uaMobile(ua: string): boolean {
	return /mobi|android|iphone|ipad|ipod/i.test(ua);
}

// Compact country -> acceptable IANA timezone prefixes, for the VPN / travel check.
// Deliberately partial: only flag when we have a confident mismatch, else stay quiet.
const COUNTRY_TZ: Record<string, string[]> = {
	US: ["America/", "Pacific/Honolulu", "Pacific/Pago", "America/Adak"],
	CA: ["America/"],
	MX: ["America/"],
	GB: ["Europe/London"],
	IE: ["Europe/Dublin"],
	FR: ["Europe/Paris"],
	DE: ["Europe/Berlin", "Europe/Busingen"],
	NL: ["Europe/Amsterdam"],
	ES: ["Europe/Madrid", "Africa/Ceuta", "Atlantic/Canary"],
	IT: ["Europe/Rome"],
	SE: ["Europe/Stockholm"],
	NO: ["Europe/Oslo"],
	PL: ["Europe/Warsaw"],
	JP: ["Asia/Tokyo"],
	CN: ["Asia/Shanghai", "Asia/Urumqi"],
	IN: ["Asia/Kolkata", "Asia/Calcutta"],
	AU: ["Australia/", "Antarctica/Macquarie"],
	NZ: ["Pacific/Auckland", "Pacific/Chatham"],
	BR: ["America/"],
	SG: ["Asia/Singapore"],
	KR: ["Asia/Seoul"],
};

export function checkConsistency(
	server: ServerSignals,
	trace: EdgeTrace | null,
	client: ClientView,
): Contradiction[] {
	const out: Contradiction[] = [];
	const sUa = server.userAgent ?? "";
	const cUa = client.userAgent ?? "";

	// 1. UA header vs navigator.userAgent — should be byte-identical.
	if (sUa && cUa && sUa !== cUa) {
		out.push({
			id: "ua.header-vs-js",
			severity: "high",
			title: "Your User-Agent header and navigator.userAgent don't match",
			detail: "The browser normally sends the same UA string in the header and in JS. A difference means one is being spoofed — the classic automation/anti-detect tell.",
			evidence: [
				{ label: "header", value: sUa },
				{ label: "navigator.userAgent", value: cUa },
			],
		});
	}

	// 2. Sec-CH-UA presence vs UA family (Chromium-only header).
	const fam = uaFamily(cUa || sUa);
	const hasCh = !!(server.secChUa && server.secChUa.trim());
	if (fam === "chromium" && !hasCh) {
		out.push({
			id: "ch.missing-on-chromium",
			severity: "high",
			title: "UA claims Chromium, but no Sec-CH-UA header was sent",
			detail: "Chromium browsers send Sec-CH-UA client hints by default. A Chrome/Edge UA with no Sec-CH-UA is almost always a spoofed UA on a non-Chromium engine.",
			evidence: [
				{ label: "UA family", value: "Chromium" },
				{ label: "Sec-CH-UA", value: "(absent)" },
			],
		});
	}
	if ((fam === "firefox" || fam === "safari") && hasCh) {
		out.push({
			id: "ch.present-on-nonchromium",
			severity: "high",
			title: `UA claims ${fam === "firefox" ? "Firefox" : "Safari"}, but a Sec-CH-UA header was sent`,
			detail: "Firefox and Safari do not send Sec-CH-UA at all. Its presence under their UA means the UA is spoofed on a Chromium engine.",
			evidence: [
				{ label: "UA family", value: fam === "firefox" ? "Firefox" : "Safari" },
				{ label: "Sec-CH-UA", value: server.secChUa ?? "" },
			],
		});
	}

	// 3. deviceMemory (Chromium-only API) present under a non-Chromium UA.
	if (client.deviceMemory !== undefined && (fam === "firefox" || fam === "safari")) {
		out.push({
			id: "devicememory.on-nonchromium",
			severity: "high",
			title: "navigator.deviceMemory is present under a non-Chromium UA",
			detail: "deviceMemory is a Chromium-only API; Firefox and Safari don't implement it. Seeing a value here contradicts the claimed browser.",
			evidence: [
				{ label: "UA family", value: fam === "firefox" ? "Firefox" : "Safari" },
				{ label: "deviceMemory", value: String(client.deviceMemory) },
			],
		});
	}

	// 4. navigator.vendor vs UA family.
	if (fam === "chromium" && client.vendor === "") {
		out.push({
			id: "vendor.empty-on-chromium",
			severity: "medium",
			title: "UA claims Chromium, but navigator.vendor is empty",
			detail: 'Chromium sets navigator.vendor to "Google Inc."; an empty vendor is the Firefox behaviour, contradicting the UA.',
			evidence: [
				{ label: "UA family", value: "Chromium" },
				{ label: "navigator.vendor", value: "(empty)" },
			],
		});
	}
	if (fam === "firefox" && /google/i.test(client.vendor)) {
		out.push({
			id: "vendor.google-on-firefox",
			severity: "medium",
			title: 'UA claims Firefox, but navigator.vendor is "Google Inc."',
			detail: "Firefox leaves navigator.vendor empty. A Google vendor string under a Firefox UA is a spoof.",
			evidence: [
				{ label: "UA family", value: "Firefox" },
				{ label: "navigator.vendor", value: client.vendor },
			],
		});
	}

	// 5. navigator.platform vs UA OS.
	const os = uaOs(cUa || sUa);
	const plat = client.platform.toLowerCase();
	const platOk =
		(os === "windows" && plat.includes("win")) ||
		(os === "macos" && (plat.includes("mac") || plat.includes("iphone"))) ||
		(os === "linux" && (plat.includes("linux") || plat.includes("x86") || plat.includes("arm"))) ||
		(os === "android" && (plat.includes("linux") || plat.includes("arm") || plat.includes("android"))) ||
		(os === "ios" && (plat.includes("iphone") || plat.includes("ipad") || plat.includes("mac"))) ||
		os === "unknown" ||
		plat === "" ||
		plat === "(unavailable)";
	if (!platOk) {
		out.push({
			id: "platform.vs-ua-os",
			severity: "high",
			title: "navigator.platform disagrees with the OS in your UA",
			detail: "The platform string should match the operating system named in the user agent. A mismatch is a spoofing tell.",
			evidence: [
				{ label: "UA OS", value: os },
				{ label: "navigator.platform", value: client.platform },
			],
		});
	}

	// 6. maxTouchPoints vs UA form factor.
	if (client.maxTouchPoints === 0 && uaMobile(cUa || sUa)) {
		out.push({
			id: "touch.zero-on-mobile",
			severity: "medium",
			title: "UA claims a mobile device, but reports zero touch points",
			detail: "Phones and tablets report touch support. Zero touch points under a mobile UA is unusual — often an emulated or spoofed mobile profile.",
			evidence: [
				{ label: "UA", value: "mobile" },
				{ label: "maxTouchPoints", value: "0" },
			],
		});
	}

	// 7. Fractional devicePixelRatio (Windows scaling) vs a Mac/iOS UA.
	if (client.dpr % 1 !== 0 && (os === "macos" || os === "ios")) {
		out.push({
			id: "dpr.fractional-on-apple",
			severity: "info",
			title: "Fractional device pixel ratio under an Apple UA",
			detail: "Fractional ratios (1.25 / 1.5 / 1.75) come from Windows display scaling; Apple devices use whole-number ratios. Often just page zoom, but worth noting.",
			evidence: [
				{ label: "UA OS", value: os },
				{ label: "devicePixelRatio", value: String(client.dpr) },
			],
		});
	}

	// 8. Accept-Language header vs navigator.language.
	if (server.acceptLanguage && client.language) {
		const headerPrimary = server.acceptLanguage.split(",")[0].trim().toLowerCase();
		const jsPrimary = client.language.toLowerCase();
		if (headerPrimary && jsPrimary && headerPrimary.split("-")[0] !== jsPrimary.split("-")[0]) {
			out.push({
				id: "lang.header-vs-js",
				severity: "medium",
				title: "Accept-Language header and navigator.language disagree",
				detail: "The primary language in the request header should match the one JS reports. A mismatch suggests one is being overridden.",
				evidence: [
					{ label: "Accept-Language", value: server.acceptLanguage },
					{ label: "navigator.language", value: client.language },
				],
			});
		}
	}

	// 9. Timezone vs IP country — the classic VPN tell. Suppressed when on WARP,
	//    because then the edge IP is Cloudflare's, not the user's real location.
	const onWarp = trace?.warp === "on" || trace?.warp === "plus";
	const country = (trace?.loc || server.cfCountry || "").toUpperCase();
	if (!onWarp && country && COUNTRY_TZ[country] && client.timezone && client.timezone !== "UTC") {
		const ok = COUNTRY_TZ[country].some((prefix) => client.timezone.startsWith(prefix));
		if (!ok) {
			out.push({
				id: "tz.vs-ip-country",
				severity: "medium",
				title: "Your timezone doesn't match the country of your IP",
				detail: "The edge sees your connection coming from " + country + ", but your browser timezone is " + client.timezone + ". That's the classic VPN/proxy signature — or you're travelling.",
				evidence: [
					{ label: "IP country (edge)", value: country },
					{ label: "browser timezone", value: client.timezone },
				],
			});
		}
	}

	return out;
}

export type Verdict = "coherent" | "minor" | "contradictions";

export function verdictOf(list: Contradiction[]): Verdict {
	if (list.some((c) => c.severity === "high")) return "contradictions";
	if (list.some((c) => c.severity === "medium")) return "minor";
	return "coherent";
}
