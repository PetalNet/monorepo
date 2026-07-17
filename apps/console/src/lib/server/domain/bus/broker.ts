import { asynchronously } from "#domain/iteration";
// The bus broker (contract §4.1, bus-frame.schema.json). Fan-out to scoped subscribers with an
// EXACT replay→live cutover: register the live buffer BEFORE capturing the boundary, replay
// seq<=boundary from the lake, flush the buffer for seq>boundary once, then stream live. Bounded
// per-subscriber queue; overflow emits an honest gap frame (client heals via `since`), never a
// silent drop. Grant change re-fences (drops subs whose scope narrowed).

import type { Emission } from "../emission.ts";
import { whileCondition } from "../iteration.ts";

export interface SubscribeSpec {
	readonly subId: string;
	readonly pattern: string;
	readonly filter?:
		| { severity_gte?: string; source_service?: string; subject?: string }
		| undefined;
	readonly since?: number | undefined;
	readonly scopes: readonly string[];
}

export type SendFrame = (frame: Record<string, unknown>) => void;

/**
 * Replay lake rows seq in (since, through] matching pattern∩scope∩filter, in seq order, invoking
 * `onRow` for each. MUST paginate internally through the full range (no silent truncation) and
 * throw on failure, so subscribe can resync rather than go live on an incomplete replay.
 */
export type ReplayFn = (
	spec: SubscribeSpec,
	throughSeq: number,
	onRow: (seq: number, e: Emission) => void,
) => Promise<void>;

const SEV_ORDER = ["debug", "info", "warn", "danger", "p0"];
const QUEUE_MAX = 1000;

export function matchPattern(pattern: string, type: string): boolean {
	const patternSegments = pattern.split(".");
	const typeSegments = type.split(".");
	if (
		patternSegments.some(
			(segment) => !segment || (segment.includes("*") && segment !== "*" && segment !== "**"),
		) ||
		typeSegments.some((segment) => !segment)
	)
		return false;
	// The contract keeps the historical trailing `.*` convenience: unlike a `*` elsewhere, it
	// spans the remainder of the dotted type. Normalize it to the canonical globstar grammar.
	if (patternSegments.at(-1) === "*" && patternSegments.length > 1)
		patternSegments[patternSegments.length - 1] = "**";

	const memo = new Map<string, boolean>();
	const matches = (patternIndex: number, typeIndex: number): boolean => {
		const key = `${String(patternIndex)}:${String(typeIndex)}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		let result: boolean;
		if (patternIndex === patternSegments.length) result = typeIndex === typeSegments.length;
		else if (patternSegments[patternIndex] === "**")
			result =
				matches(patternIndex + 1, typeIndex) ||
				(typeIndex < typeSegments.length && matches(patternIndex, typeIndex + 1));
		else
			result =
				typeIndex < typeSegments.length &&
				(patternSegments[patternIndex] === "*" ||
					patternSegments[patternIndex] === typeSegments[typeIndex]) &&
				matches(patternIndex + 1, typeIndex + 1);
		memo.set(key, result);
		return result;
	};
	return matches(0, 0);
}

function passesFilter(spec: SubscribeSpec, e: Emission): boolean {
	const f = spec.filter;
	if (!f) return true;
	if (f.severity_gte && SEV_ORDER.indexOf(e.severity) < SEV_ORDER.indexOf(f.severity_gte))
		return false;
	if (f.source_service && e.source.service !== f.source_service) return false;
	if (f.subject && e.subject !== f.subject) return false;
	return true;
}

interface Sub {
	ownerId: string;
	spec: SubscribeSpec;
	send: SendFrame;
	live: boolean;
	buffer: { seq: number; emission: Emission }[]; // pre-live live-events awaiting flush
	queue: { seq: number; emission: Emission }[]; // live send queue
	draining: boolean;
	gapFrom: number | null;
	gapTo: number;
	closed: boolean;
}

export class Broker {
	readonly #subs = new Map<string, Sub>();
	readonly #replay: ReplayFn;
	#head = 0;

	constructor(replay: ReplayFn) {
		this.#replay = replay;
	}

	get head(): number {
		return this.#head;
	}

	/**
	 * Initialize the head from the lake's MAX(seq) at boot, so a post-restart `since:0` subscribe
	 * replays persisted history rather than skipping it (codex N1a P1).
	 */
	setHead(seq: number): void {
		if (seq > this.#head) this.#head = seq;
	}

	/** Called by the appender post-commit, in seq order. */
	onEvent(seq: number, e: Emission): void {
		if (seq > this.#head) this.#head = seq;
		for (const sub of this.#subs.values()) {
			if (sub.closed) continue;
			if (!matchPattern(sub.spec.pattern, e.type)) continue;
			if (!sub.spec.scopes.includes(e.scope)) continue; // in-memory scope guard (defense in depth)
			if (!passesFilter(sub.spec, e)) continue;
			if (sub.live) this.#enqueue(sub, seq, e);
			else sub.buffer.push({ seq, emission: e });
		}
	}

	async subscribe(
		ownerId: string,
		spec: SubscribeSpec,
		send: SendFrame,
		onRegistered?: () => void,
	): Promise<boolean> {
		const key = subscriptionKey(ownerId, spec.subId);
		if (this.#subs.has(key)) {
			// reject WITHOUT overwriting the live subscription (would orphan it — sub-agent M3)
			send({
				schema_version: 1,
				kind: "ack",
				sub_id: spec.subId,
				replay_through_seq: this.#head,
				error: { code: "sub_id_in_use", message: "sub_id already active", retryable: false },
			});
			return false;
		}
		const sub: Sub = {
			ownerId,
			spec,
			send,
			live: false,
			buffer: [],
			queue: [],
			draining: false,
			gapFrom: null,
			gapTo: 0,
			closed: false,
		};
		// register BEFORE capturing the boundary so nothing fanned after now is lost
		this.#subs.set(key, sub);
		onRegistered?.();
		const boundary = this.#head;
		send({ schema_version: 1, kind: "ack", sub_id: spec.subId, replay_through_seq: boundary });
		try {
			await this.#replay(spec, boundary, (seq, e) => {
				send(frame(spec.subId, seq, e));
			});
		} catch (err) {
			// incomplete replay: resync, do NOT go live on a known-incomplete stream (codex N1a P2)
			send({
				schema_version: 1,
				kind: "resync_required",
				sub_id: spec.subId,
				oldest_seq: boundary,
				message: String(err),
			});
			this.#remove(sub);
			return true;
		}
		// flush buffered live events with seq > boundary exactly once, then go live
		if (sub.closed) return true;
		const flush = sub.buffer.filter((b) => b.seq > boundary).toSorted((a, b) => a.seq - b.seq);
		for (const b of flush) send(frame(spec.subId, b.seq, b.emission));
		sub.buffer = [];
		sub.live = true;
		return true;
	}

	unsubscribe(ownerId: string, subId: string): void {
		const key = subscriptionKey(ownerId, subId);
		const sub = this.#subs.get(key);
		if (sub) sub.closed = true;
		this.#subs.delete(key);
	}

	/** Re-fence on grant change: drop subs whose new scope set no longer covers their pattern's scope. */
	revalidateScopes(
		ownerId: string,
		connSubIds: readonly string[],
		newScopes: readonly string[],
	): void {
		for (const subId of connSubIds) {
			const sub = this.#subs.get(subscriptionKey(ownerId, subId));
			if (!sub) continue;
			const narrowed = sub.spec.scopes.some((s) => !newScopes.includes(s));
			if (narrowed) {
				sub.send({
					schema_version: 1,
					kind: "resync_required",
					sub_id: subId,
					oldest_seq: this.#head,
					message: "grant changed",
				});
				this.unsubscribe(ownerId, subId);
			}
		}
	}

	#remove(sub: Sub): void {
		sub.closed = true;
		const key = subscriptionKey(sub.ownerId, sub.spec.subId);
		if (this.#subs.get(key) === sub) this.#subs.delete(key);
	}

	#enqueue(sub: Sub, seq: number, e: Emission): void {
		if (sub.queue.length >= QUEUE_MAX) {
			if (sub.gapFrom === null) sub.gapFrom = seq;
			sub.gapTo = seq;
			return;
		}
		sub.queue.push({ seq, emission: e });
		if (!sub.draining) void this.#drain(sub);
	}

	async #drain(sub: Sub): Promise<void> {
		sub.draining = true;
		try {
			for await (const iteration of asynchronously(
				whileCondition(() => sub.queue.length > 0 && !sub.closed),
			)) {
				void iteration;
				const item = sub.queue.shift();
				if (!item) break;
				sub.send(frame(sub.spec.subId, item.seq, item.emission));
				// yield so a slow socket doesn't block the event loop
				await Promise.resolve();
			}
			if (sub.gapFrom !== null && !sub.closed) {
				sub.send({
					schema_version: 1,
					kind: "gap",
					sub_id: sub.spec.subId,
					from_seq: sub.gapFrom,
					to_seq: sub.gapTo,
					reason: "backpressure",
				});
				sub.gapFrom = null;
			}
		} finally {
			sub.draining = false;
		}
	}
}

function subscriptionKey(ownerId: string, subId: string): string {
	return `${ownerId}\u0000${subId}`;
}

function frame(subId: string, seq: number, emission: Emission): Record<string, unknown> {
	return { schema_version: 1, kind: "event", sub_id: subId, seq, emission };
}
