// Cross-context linkability test.
//
// The reproducibility axis, made concrete: does your fingerprint survive the jump to
// another browsing context? Each context computes its OWN stable-fingerprint hash
// locally. To compare, we carry the reference hash in the URL FRAGMENT (#ref=...),
// which is never sent to any server — nothing is stored anywhere. The far side
// derives its own hash independently and only DIFFS against the carried reference;
// it never echoes the value back, so a match actually means both sides landed on the
// same fingerprint separately.
//
// The honesty line the UI must show: a subdomain is the SAME site (eTLD+1), so
// cookies and storage aren't partitioned — a real tracker wouldn't even need your
// fingerprint here, it'd set a cookie. We manually isolate (no cookies, no shared
// storage, hash only) so the test isolates purely the FINGERPRINT channel. A true
// cross-SITE test needs a second registrable domain.

export interface CarriedRef {
	hash: string;
	fromHost: string | null;
	/** True when the reference came from a different host (a real jump vs a refresh) */
	crossContext: boolean;
}

/** Read a reference hash a sibling context carried in the fragment. */
export function readCarriedRef(): CarriedRef | null {
	if (typeof window === "undefined") return null;
	const frag = window.location.hash.replace(/^#/, "");
	if (!frag) return null;
	const params = new URLSearchParams(frag);
	const hash = params.get("ref");
	if (!hash) return null;
	const fromHost = params.get("from");
	return {
		hash,
		fromHost,
		crossContext: !!fromHost && fromHost !== window.location.host,
	};
}

/**
 * Build a URL that opens the same app in a sibling context, carrying THIS context's hash as the
 * reference. Defaults to the same origin (so it works today for the refresh / incognito / container
 * / VPN cases); pass a sibling host for the cross-context demo.
 */
export function buildJumpUrl(myHash: string, siblingHost?: string): string {
	if (typeof window === "undefined") return "#";
	const origin = siblingHost
		? `${window.location.protocol}//${siblingHost}`
		: window.location.origin;
	const frag = new URLSearchParams({ ref: myHash, from: window.location.host });
	return `${origin}${window.location.pathname}#${frag.toString()}`;
}

export type LinkResult = "match" | "differ";

export function compareHashes(mine: string, carried: string): LinkResult {
	return mine === carried ? "match" : "differ";
}
