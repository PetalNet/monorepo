// Secret scrubber (contract Rule 6). Applied at the emit door: an emission that carries a
// claim_token, an Authorization header value, or a token-shaped string is REJECTED (fail-loud),
// not silently stripped — a producer trying to put a secret on the bus is a bug to surface.

import type { Emission } from "../emission.ts";

// Token-shaped: long opaque high-entropy strings and the known lab token prefixes.
const TOKEN_SHAPES: readonly RegExp[] = [
	/\bclaim_token\b/i,
	/^bearer\s+/i,
	/\bghp_[A-Za-z0-9]{20,}/,
	/\bsk-[A-Za-z0-9]{20,}/,
	/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWT-ish
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

/** Reject an emission whose dimensions/measures/meta/body_ref carry a secret. */
export function scrubEmission(e: Emission): ScrubResult {
	for (const [field, val] of [
		["dimensions", e.dimensions],
		["measures", e.measures],
		["meta", e.meta],
	] as const) {
		if (val === undefined) continue;
		const hit = scan(val, field);
		if (hit) return { ok: false, where: hit };
	}
	if (e.body_ref && TOKEN_SHAPES.some((re) => re.test(e.body_ref as string)))
		return { ok: false, where: "body_ref" };
	return { ok: true };
}
