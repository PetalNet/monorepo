// Secret scrubber (contract Rule 6). Applied at the emit door: an emission that carries a
// claim_token, an Authorization header value, or a token-shaped string is REJECTED (fail-loud),
// not silently stripped — a producer trying to put a secret on the bus is a bug to surface.

import type { Emission } from "../emission.ts";

// Token-shaped: long opaque high-entropy strings and the known lab token prefixes.
const TOKEN_SHAPES: readonly RegExp[] = [
	/\bclaim_token\b/i,
	/bearer\s+[A-Za-z0-9._-]/i,
	/\bghp_[A-Za-z0-9]{20,}/,
	/\bsk-[A-Za-z0-9]{20,}/,
	/\bcbt_[A-Za-z0-9_-]{20,}/, // console-api bearer prefix
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT (eyJ header)
	/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // long JWT-ish
];
const SECRET_KEYS = new Set([
	"claim_token",
	"authorization",
	"token",
	"secret",
	"access_token",
	"password",
]);

export interface ScrubResult {
	readonly ok: boolean;
	readonly where?: string;
}

function scan(value: unknown, path: string): string | null {
	if (typeof value === "string") {
		for (const re of TOKEN_SHAPES) if (re.test(value)) return path;
		return null;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const hit = scan(value[i], `${path}[${String(i)}]`);
			if (hit) return hit;
		}
		return null;
	}
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (SECRET_KEYS.has(k.toLowerCase())) return `${path}.${k}`;
			const hit = scan(v, `${path}.${k}`);
			if (hit) return hit;
		}
	}
	return null;
}

/**
 * Reject an emission that carries a secret ANYWHERE a string could hide (sub-agent M2): action,
 * subject, source.*, dimensions, measures, links, meta, body_ref. Scanning the whole envelope is
 * safe — the structurally-constrained fields (type, scope, severity, uuid id, ts) never match a
 * token shape, and a secret in `action` or a `links[].to.id` matters as much as one in a dimension.
 * Fail-loud: a producer putting a secret on the bus is a bug to surface, not to silently strip.
 */
export function scrubEmission(e: Emission): ScrubResult {
	const hit = scan(e, "emission");
	return hit ? { ok: false, where: hit } : { ok: true };
}
