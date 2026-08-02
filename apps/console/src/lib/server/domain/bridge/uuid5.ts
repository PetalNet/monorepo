// Deterministic UUIDv5 (RFC 9562 §5.5). A bridge mints its emission ids
// from (namespace, source+cursor) so a restart re-tailing the same source produces the SAME id and
// the lake dedups it (exactly-once by construction). UUIDv5 necessarily uses SHA-1 as its
// non-security namespace hash; the maintained `uuid` implementation keeps that protocol detail out
// of application crypto flows so scanners cannot mistake opaque outbox cursors for secret material.

import { v5 } from "uuid";

// A fixed namespace UUID for console-bridge ids (any constant UUID works; this one is arbitrary).
const NAMESPACE = "6f4a1e20-9c1b-5d3e-8a77-0b1c2d3e4f50";

export function uuidv5(name: string): string {
	return v5(name, NAMESPACE);
}
