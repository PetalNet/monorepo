// Tiny in-process token-bucket rate limiter. Single-instance app (one node process
// behind Authentik forward-auth), so an in-memory map is sufficient — no shared store
// needed. Buckets are keyed by an arbitrary string (e.g. "tts:<user>" and a global key).
//
// take(key, opts) refills `rate` tokens/sec up to `capacity`, then spends one token.
// Returns { ok, retryAfter } — retryAfter is whole seconds until the next token.
//
// Idle buckets are pruned opportunistically so the map can't grow unbounded from a
// flood of distinct keys.

const buckets = new Map();
let lastPrune = 0;

export function take(key, { capacity = 10, rate = 0.2, now = Date.now() } = {}) {
	// opportunistic prune: drop buckets that have been full + untouched for >10 min
	if (now - lastPrune > 60_000) {
		lastPrune = now;

		for (const [k, b] of buckets) {
			const refilled = Math.min(capacity, b.tokens + ((now - b.ts) / 1000) * rate);

			if (refilled >= capacity && now - b.ts > 600_000) {
				buckets.delete(k);
			}
		}
	}

	let b = buckets.get(key);

	if (!b) {
		b = { tokens: capacity, ts: now };
		buckets.set(key, b);
	}

	// refill since last touch
	b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 1000) * rate);
	b.ts = now;

	if (b.tokens >= 1) {
		b.tokens -= 1;

		return { ok: true, retryAfter: 0 };
	}

	// seconds until a whole token is available again
	const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / rate));

	return { ok: false, retryAfter };
}

// test/maintenance helper
