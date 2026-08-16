import type { EdgeTrace } from "./consistency";

// The Cloudflare edge trace. Our own origin is behind Cloudflare, so /cdn-cgi/trace
// is same-origin — the edge serves it regardless of the tunnel, and it reports what
// the NETWORK layer sees about you: WARP, Zero-Trust Gateway, the country of your
// exit IP, and the negotiated TLS version.
//
// This is the honest version of "what's my DNS": a plain same-origin fetch cannot
// name your DNS resolver (resolution already happened upstream), but it CAN tell you
// whether you're on WARP / Gateway and where the edge thinks you are.
export async function fetchTrace(): Promise<EdgeTrace | null> {
	try {
		const res = await fetch("/cdn-cgi/trace", { cache: "no-store" });
		if (!res.ok) return null;
		const text = await res.text();
		const map: Record<string, string> = {};
		for (const line of text.split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0) map[line.slice(0, eq)] = line.slice(eq + 1);
		}
		// Only treat this as a real CF trace if the signature fields are present.
		if (!("warp" in map) && !("colo" in map)) return null;
		return {
			warp: map.warp ?? null,
			gateway: map.gateway ?? null,
			loc: map.loc ?? null,
			tls: map.tls ?? null,
			colo: map.colo ?? null,
			ip: map.ip ?? null,
			rbi: map.rbi ?? null,
		};
	} catch {
		return null;
	}
}
