// The bus broker (contract §4.1, bus-frame.schema.json). Fan-out to scoped subscribers with an
// EXACT replay→live cutover: register the live buffer BEFORE capturing the boundary, replay
// seq<=boundary from the lake, flush the buffer for seq>boundary once, then stream live. Bounded
// per-subscriber queue; overflow emits an honest gap frame (client heals via `since`), never a
// silent drop. Grant change re-fences (drops subs whose scope narrowed).

import type { Emission } from "../emission.ts";

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
	if (pattern === type) return true;
	if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1)); // doorman.* → doorman.link.flap
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1); // ".flap"
		const seg = type.split(".");
		return seg.length >= 2 && `.${seg[seg.length - 1]}` === suffix;
	}
	return false;
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

	async subscribe(spec: SubscribeSpec, send: SendFrame): Promise<void> {
		if (this.#subs.has(spec.subId)) {
			// reject WITHOUT overwriting the live subscription (would orphan it — sub-agent M3)
			send({
				schema_version: 1,
				kind: "ack",
				sub_id: spec.subId,
				replay_through_seq: this.#head,
				error: { code: "sub_id_in_use", message: "sub_id already active", retryable: false },
			});
			return;
		}
		const sub: Sub = {
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
		this.#subs.set(spec.subId, sub);
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
			this.unsubscribe(spec.subId);
			return;
		}
		// flush buffered live events with seq > boundary exactly once, then go live
		if (sub.closed) return;
		const flush = sub.buffer.filter((b) => b.seq > boundary).sort((a, b) => a.seq - b.seq);
		for (const b of flush) send(frame(spec.subId, b.seq, b.emission));
		sub.buffer = [];
		sub.live = true;
	}

	unsubscribe(subId: string): void {
		const sub = this.#subs.get(subId);
		if (sub) sub.closed = true;
		this.#subs.delete(subId);
	}

	/** Re-fence on grant change: drop subs whose new scope set no longer covers their pattern's scope. */
	refence(connSubIds: readonly string[], newScopes: readonly string[]): void {
		for (const subId of connSubIds) {
			const sub = this.#subs.get(subId);
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
				this.unsubscribe(subId);
			}
		}
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
			while (sub.queue.length > 0 && !sub.closed) {
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

function frame(subId: string, seq: number, emission: Emission): Record<string, unknown> {
	return { schema_version: 1, kind: "event", sub_id: subId, seq, emission };
}
