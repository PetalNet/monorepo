import type { PageServerLoad } from "./$types";

// Server-side signal capture. Reads only what the request already carries — no
// logging, no storage, no cookies. These header values are compared against the
// JS environment on the client to surface cross-surface contradictions (the thing
// a real tracker checks that CoverYourTracks does not).
//
// Note on what is NOT here: TLS JA3/JA4 and HTTP/2 pseudo-header ORDER are the
// richest server-only fingerprints, but this app sits behind a Cloudflare tunnel,
// which terminates TLS and normalises headers — so the ClientHello and raw header
// order never reach the origin (they'd need CF Enterprise Bot Management). We show
// what actually survives to the origin, and say so.
export const load: PageServerLoad = ({ request, getClientAddress }) => {
	const h = request.headers;
	let ip: string | null = h.get("cf-connecting-ip");
	if (!ip) {
		try {
			ip = getClientAddress();
		} catch {
			ip = null;
		}
	}

	return {
		server: {
			userAgent: h.get("user-agent"),
			acceptLanguage: h.get("accept-language"),
			acceptEncoding: h.get("accept-encoding"),
			accept: h.get("accept"),
			secChUa: h.get("sec-ch-ua"),
			secChUaPlatform: h.get("sec-ch-ua-platform"),
			secChUaMobile: h.get("sec-ch-ua-mobile"),
			dnt: h.get("dnt"),
			cfCountry: h.get("cf-ipcountry"),
			cfRay: h.get("cf-ray"),
			ip,
		},
	};
};
