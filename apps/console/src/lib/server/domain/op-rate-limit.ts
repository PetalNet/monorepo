import type { Principal } from "./auth/principal.ts";
import type { Services } from "./substrate.ts";

interface Bucket {
	tokens: number;
	updatedAt: number;
	lastSeen: number;
}
interface Store {
	buckets: Map<string, Bucket>;
	checks: number;
}
export interface RateLimitDecision {
	readonly allowed: boolean;
	readonly retryAfterS: number;
}

const stores = new WeakMap<Services, Store>();

/** One process-wide 30/minute command bucket shared by HTTP and in-process command calls. */
export function consumeOpRateLimit(services: Services, principal: Principal): RateLimitDecision {
	let store = stores.get(services);
	if (!store) {
		store = { buckets: new Map(), checks: 0 };
		stores.set(services, store);
	}
	const now = Date.now();
	const capacity = 30;
	const refillPerMs = capacity / 60_000;
	const previous = store.buckets.get(principal.id);
	const tokens = Math.min(
		capacity,
		(previous?.tokens ?? capacity) + (now - (previous?.updatedAt ?? now)) * refillPerMs,
	);
	store.checks += 1;
	if (store.checks % 256 === 0 || store.buckets.size >= 10_000) {
		for (const [key, bucket] of store.buckets)
			if (now - bucket.lastSeen > 10 * 60_000) store.buckets.delete(key);
		if (store.buckets.size >= 10_000) {
			const oldest = [...store.buckets].toSorted(
				([, left], [, right]) => left.lastSeen - right.lastSeen,
			)[0]?.[0];
			if (oldest) store.buckets.delete(oldest);
		}
	}
	if (tokens < 1) {
		const retryAfterS = Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1_000));
		store.buckets.set(principal.id, { tokens, updatedAt: now, lastSeen: now });
		return { allowed: false, retryAfterS };
	}
	store.buckets.set(principal.id, { tokens: tokens - 1, updatedAt: now, lastSeen: now });
	return { allowed: true, retryAfterS: 0 };
}
