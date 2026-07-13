import { randomUUID } from "node:crypto";

import { describe, it, expect } from "vitest";

import { Broker, type SubscribeSpec } from "../src/bus/broker.ts";
import type { Emission } from "../src/emission.ts";

function ev(seq: number): Emission {
	return {
		schema_version: 1,
		id: randomUUID(),
		type: "host.cpu.pct",
		ts: new Date().toISOString(),
		source: { service: "bridge", host: ".15", agent: null },
		subject: `.${String(seq)}`,
		severity: "info",
		scope: "fleet",
	};
}

const spec = (subId: string, since?: number): SubscribeSpec => ({
	subId,
	pattern: "host.*",
	since,
	scopes: ["fleet"],
});

describe("broker cutover", () => {
	it("replays <= boundary then streams live > boundary, exactly once", async () => {
		// replay streams the two historical events (seq 1,2)
		const broker = new Broker(async (_spec, _through, onRow) => {
			onRow(1, ev(1));
			onRow(2, ev(2));
		});
		broker.onEvent(1, ev(1));
		broker.onEvent(2, ev(2)); // head is now 2 (the boundary)
		const frames: Record<string, unknown>[] = [];
		await broker.subscribe(spec("s1", 0), (f) => frames.push(f));
		// live event after cutover
		broker.onEvent(3, ev(3));
		await new Promise((r) => setTimeout(r, 20));

		const kinds = frames.map((f) => f["kind"]);
		expect(kinds[0]).toBe("ack");
		expect(frames[0]["replay_through_seq"]).toBe(2);
		const eventSeqs = frames.filter((f) => f["kind"] === "event").map((f) => f["seq"]);
		expect(eventSeqs).toEqual([1, 2, 3]); // no dup, no gap, in order
	});

	it("buffers a live event that arrives during replay, flushes once", async () => {
		let releaseReplay: (() => void) | null = null;
		const gate = new Promise<void>((res) => {
			releaseReplay = res;
		});
		const broker = new Broker(async (_spec, _through, onRow) => {
			await gate; // hold replay open
			onRow(1, ev(1));
		});
		broker.onEvent(1, ev(1)); // head = 1 (boundary)
		const frames: Record<string, unknown>[] = [];
		const subP = broker.subscribe(spec("s2", 0), (f) => frames.push(f));
		// a live event arrives WHILE replay is blocked
		broker.onEvent(2, ev(2));
		releaseReplay?.();
		await subP;
		await new Promise((r) => setTimeout(r, 20));
		const eventSeqs = frames.filter((f) => f["kind"] === "event").map((f) => f["seq"]);
		expect(eventSeqs).toEqual([1, 2]); // buffered seq 2 flushed after replayed seq 1, once
	});

	it("emits a gap frame under backpressure instead of dropping silently", async () => {
		const broker = new Broker(async () => {});
		const frames: Record<string, unknown>[] = [];
		await broker.subscribe(spec("s3"), (f) => frames.push(f)); // live immediately (no since)
		for (let i = 1; i <= 1500; i++) broker.onEvent(i, ev(i)); // overflow QUEUE_MAX=1000
		await new Promise((r) => setTimeout(r, 100));
		const gap = frames.find((f) => f["kind"] === "gap");
		expect(gap).toBeDefined();
		expect(Number(gap?.["to_seq"])).toBe(1500);
	});

	it("does not deliver events outside the subscriber scope", async () => {
		const broker = new Broker(async () => {});
		const frames: Record<string, unknown>[] = [];
		await broker.subscribe({ subId: "s4", pattern: "*", scopes: ["user:parker"] }, (f) =>
			frames.push(f),
		);
		broker.onEvent(1, { ...ev(1), scope: "user:eli" }); // eli's event, parker's sub
		await new Promise((r) => setTimeout(r, 20));
		expect(frames.filter((f) => f["kind"] === "event")).toHaveLength(0);
	});

	it("fails closed before an event can race a grant-change revalidation", async () => {
		const broker = new Broker(async () => {});
		const frames: Record<string, unknown>[] = [];
		await broker.subscribe(spec("grant-race"), (frame) => frames.push(frame));
		broker.revalidateScopes(["grant-race"], []);
		broker.onEvent(1, ev(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frames.some((frame) => frame["kind"] === "resync_required")).toBe(true);
		expect(frames.filter((frame) => frame["kind"] === "event")).toHaveLength(0);
	});
});
