// Deterministic UUIDv5 (RFC 4122 §4.3) via node:crypto — no dep. A bridge mints its emission ids
// from (namespace, source+cursor) so a restart re-tailing the same source produces the SAME id and
// the lake dedups it (exactly-once by construction). node:crypto has no built-in v5, so we compose
// it: sha1(namespace_bytes || name), then stamp version 5 + RFC variant.

import { createHash } from "node:crypto";

// A fixed namespace UUID for console-bridge ids (any constant UUID works; this one is arbitrary).
const NAMESPACE = "6f4a1e20-9c1b-5d3e-8a77-0b1c2d3e4f50";

function uuidToBytes(u: string): Buffer {
	return Buffer.from(u.replace(/-/g, ""), "hex");
}

export function uuidv5(name: string): string {
	const hash = createHash("sha1");
	hash.update(uuidToBytes(NAMESPACE));
	hash.update(Buffer.from(name, "utf8"));
	const bytes = hash.digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
