import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, it, expect } from "vitest";

import {
	DispatcherSqliteAdapter,
	FleetSnapshotAdapter,
	JsonlSpoolAdapter,
	ManagerHeartbeatAdapter,
} from "../src/bridge/index.ts";
import { sourceCursorRef, tailSystemOutbox } from "../src/bridge/system-outbox.ts";
import { uuidv5 } from "../src/bridge/uuid5.ts";
import { parseEmission } from "../src/emission.ts";

function makeOutbox(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "console-outbox-"));
	mkdirSync(join(dir, "sent"), { recursive: true });
	for (const [name, body] of Object.entries(files))
		writeFileSync(join(dir, "sent", name), JSON.stringify(body));
	return dir;
}

describe("uuidv5", () => {
	it("is deterministic and well-formed", () => {
		const a = uuidv5("x");
		expect(a).toBe(uuidv5("x")); // stable
		expect(a).not.toBe(uuidv5("y"));
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // v5 + variant
	});

	it("preserves the persisted bridge-id fixture across implementations", () => {
		expect(uuidv5("system-outbox:200-shawn.json")).toBe("79a08f46-35ee-53a5-ac40-11e5a7acefb7");
	});
});

describe("system-outbox tailer", () => {
	it("assembles short fd reads before parsing", () => {
		const dir = makeOutbox({ "100-shawn.json": { sender: "shawn", body: "ok" } });
		const source = Buffer.from(JSON.stringify({ sender: "shawn", body: "ok" }));
		try {
			const result = tailSystemOutbox(
				dir,
				"",
				0,
				"2026-07-13T00:00:00Z",
				undefined,
				undefined,
				(_fd, target, offset, length, position) => {
					if (position >= source.length) return 0;
					const count = Math.min(3, length, source.length - position);
					source.copy(target, offset, position, position + count);
					return count;
				},
			);
			expect(result.emissions[0]?.dimensions?.["sender"]).toBe("shawn");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("maps known warnings to statistics and unknown warnings to bot.message", () => {
		const dir = makeOutbox({
			"100-shawn.json": { sender: "shawn", body: "[warn] host-janitor: .14 disk 91% used" },
			"101-derek.json": { sender: "derek", body: "[fail] container update stuck" },
			"102-michael.json": { sender: "michael", body: "board digest ready" },
		});
		try {
			const { emissions, cursor } = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(emissions).toHaveLength(3);
			expect(emissions.map((e) => e.type)).toEqual(["host.disk.pct", "bot.message", "bot.message"]);
			// fallback messages use the trustworthy source, not the spoofable claimed sender
			expect(emissions[1]?.subject).toBe("system-outbox");
			const bySender = (s: string) => emissions.find((e) => e.dimensions?.["sender"] === s);
			expect(bySender("shawn")?.severity).toBe("warn");
			expect(bySender("derek")?.severity).toBe("danger");
			expect(bySender("michael")?.severity).toBe("info");
			expect(cursor).toBe("102-michael.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("maps recognized operational messages to typed statistics", () => {
		const dir = makeOutbox({
			"100-disk.json": { sender: "shawn", body: "[warn] .14 disk 91% used" },
			"101-container.json": { sender: "derek", body: "container console-api update available" },
			"102-box.json": { sender: "michael", body: "box .15 update status changed: updates_pending" },
		});
		try {
			const { emissions } = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(emissions.map((e) => e.type)).toEqual([
				"host.disk.pct",
				"container.update_available",
				"bot.message",
			]);
			expect(emissions[0]?.subject).toBe(".14");
			expect(emissions[0]?.measures?.["pct"]).toBe(91);
			expect(emissions[1]?.subject).toBe("system-outbox");
			expect(emissions[1]?.dimensions?.["claimed_container"]).toBe("console-api");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("only returns files past the cursor, with deterministic ids (restart-safe)", () => {
		const dir = makeOutbox({
			"100-shawn.json": { sender: "shawn", body: "[warn] a" },
			"200-shawn.json": { sender: "shawn", body: "[warn] b" },
		});
		try {
			const first = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(first.emissions).toHaveLength(2);
			// re-poll from the advanced cursor: nothing new
			const second = tailSystemOutbox(
				dir,
				first.cursor,
				first.belowCount,
				"2026-07-13T00:00:01Z",
				first.belowHash,
			);
			expect(second.emissions).toHaveLength(0);
			// re-tailing the SAME file yields the SAME id (lake dedups) — deterministic
			const reid = tailSystemOutbox(dir, "100-shawn.json", 1, "2026-07-13T00:00:02Z");
			expect(reid.emissions[0]?.id).toBe(uuidv5("system-outbox:200-shawn.json"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws when the source directory is unreadable (caller emits unreachable)", () => {
		expect(() => tailSystemOutbox("/no/such/outbox", "", 0, "2026-07-13T00:00:00Z")).toThrow();
	});

	it("quarantines malformed JSON and continues with later files", () => {
		const dir = makeOutbox({ "100-shawn.json": { sender: "shawn", body: "[warn] a" } });
		// a file caught mid-write: invalid JSON, sorts between the two valid ones
		writeFileSync(join(dir, "sent", "150-derek.json"), '{"sender":"derek","body":"[fail] par');
		writeFileSync(
			join(dir, "sent", "200-shawn.json"),
			JSON.stringify({ sender: "shawn", body: "[warn] b" }),
		);
		try {
			// sent/ is atomic-rename output, so malformed JSON is stable poison and is skipped loudly.
			const first = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(first.emissions.map((e) => e.dimensions?.["sender"])).toEqual(["shawn", "shawn"]);
			expect(first.losses).toEqual([{ file: "150-derek.json", reason: "invalid_json" }]);
			expect(first.cursor).toBe("200-shawn.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recovers a late lower-sorting file via the append-only anomaly rescan", () => {
		const dir = makeOutbox({ "200-shawn.json": { sender: "shawn", body: "[warn] b" } });
		try {
			const first = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(first.emissions).toHaveLength(1);
			expect(first.cursor).toBe("200-shawn.json");
			expect(first.belowCount).toBe(1);
			// a producer now drops a file whose name sorts BELOW the cursor (non-monotonic)
			writeFileSync(
				join(dir, "sent", "150-derek.json"),
				JSON.stringify({ sender: "derek", body: "[fail] late" }),
			);
			// fast path (name > cursor) would miss 150 forever; the belowCount jump triggers a rescan
			const second = tailSystemOutbox(
				dir,
				first.cursor,
				first.belowCount,
				"2026-07-13T00:00:01Z",
				first.belowHash,
			);
			expect(second.anomaly).toBe(true);
			expect(second.emissions.map((e) => e.dimensions?.["file_ref"])).toContain(
				sourceCursorRef("150-derek.json"),
			);
			expect(second.belowCount).toBe(2);
			// next poll is quiet again — the anomaly is not re-triggered
			const third = tailSystemOutbox(
				dir,
				second.cursor,
				second.belowCount,
				"2026-07-13T00:00:02Z",
				second.belowHash,
			);
			expect(third.anomaly).toBe(false);
			expect(third.emissions).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects prune plus late insert even when the below-cursor count is unchanged", () => {
		const dir = makeOutbox({
			"100-old.json": { sender: "shawn", body: "old" },
			"200-current.json": { sender: "shawn", body: "current" },
		});
		try {
			const first = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			rmSync(join(dir, "sent", "100-old.json"));
			writeFileSync(
				join(dir, "sent", "150-late.json"),
				JSON.stringify({ sender: "derek", body: "late" }),
			);
			const second = tailSystemOutbox(
				dir,
				first.cursor,
				first.belowCount,
				"2026-07-13T00:00:01Z",
				first.belowHash,
			);
			expect(second.belowCount).toBe(first.belowCount);
			expect(second.anomaly).toBe(true);
			expect(second.emissions.map((e) => e.dimensions?.["file_ref"])).toContain(
				sourceCursorRef("150-late.json"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("coerces wrong-typed fields instead of crashing the whole source", () => {
		const dir = makeOutbox({
			"100-x.json": { sender: 1, body: { nested: true } }, // both wrong types
			"150-null.json": null,
			"200-y.json": { sender: "shawn", body: "[warn] ok" },
		});
		try {
			const { emissions } = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(emissions).toHaveLength(3); // neither throws; bad roots/fields get safe defaults
			expect(emissions[0]?.dimensions?.["sender"]).toBe("unknown");
			expect(emissions[0]?.severity).toBe("info");
			expect(emissions[1]?.dimensions?.["sender"]).toBe("unknown");
			expect(emissions[2]?.dimensions?.["sender"]).toBe("shawn");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips non-regular files (a symlink can't smuggle in unrelated JSON)", () => {
		const secret = mkdtempSync(join(tmpdir(), "console-secret-"));
		writeFileSync(
			join(secret, "elsewhere.json"),
			JSON.stringify({ sender: "attacker", body: "x" }),
		);
		const dir = makeOutbox({ "200-real.json": { sender: "shawn", body: "[warn] real" } });
		symlinkSync(join(secret, "elsewhere.json"), join(dir, "sent", "100-link.json"));
		try {
			const { emissions, losses } = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(emissions).toHaveLength(1); // the symlink is skipped, the real file is read
			expect(emissions[0]?.dimensions?.["file_ref"]).toBe(sourceCursorRef("200-real.json"));
			expect(losses).toEqual([{ file: "100-link.json", reason: "non_regular" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(secret, { recursive: true, force: true });
		}
	});

	it("reports oversize records as stable losses before advancing", () => {
		const dir = makeOutbox({ "200-real.json": { sender: "shawn", body: "ok" } });
		writeFileSync(join(dir, "sent", "100-huge.json"), "x".repeat(65 * 1024));
		try {
			const result = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(result.losses).toEqual([{ file: "100-huge.json", reason: "oversize" }]);
			expect(result.cursor).toBe("200-real.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a permission-denied record as a loss and continues", () => {
		const dir = makeOutbox({
			"100-denied.json": { sender: "shawn", body: "denied" },
			"200-real.json": { sender: "shawn", body: "ok" },
		});
		chmodSync(join(dir, "sent", "100-denied.json"), 0);
		try {
			const result = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(result.losses).toEqual([{ file: "100-denied.json", reason: "unreadable" }]);
			expect(result.emissions).toHaveLength(1);
			expect(result.cursor).toBe("200-real.json");
		} finally {
			chmodSync(join(dir, "sent", "100-denied.json"), 0o600);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries a transient open failure without advancing past later records", () => {
		const dir = makeOutbox({
			"100-first.json": { sender: "shawn", body: "first" },
			"150-vanishes.json": { sender: "shawn", body: "transient" },
			"200-later.json": { sender: "shawn", body: "later" },
		});
		try {
			const result = tailSystemOutbox(
				dir,
				"",
				0,
				"2026-07-13T00:00:00Z",
				undefined,
				(path, name) => {
					if (name === "150-vanishes.json") rmSync(path);
				},
			);
			expect(result.emissions).toHaveLength(1);
			expect(result.cursor).toBe("100-first.json");
			expect(result.losses).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("subsystem bridge adapters", () => {
	it("tails fleet snapshots with deterministic ids and change-only cursors", () => {
		const dir = mkdtempSync(join(tmpdir(), "console-fleet-"));
		const path = join(dir, "janet.json");
		const snapshot = {
			schema_version: 1,
			handle: "janet",
			host: ".15",
			event: "pre_tool",
			status: "working",
			task_id: 42,
			updated_at: "2026-07-13T00:00:00Z",
		};
		writeFileSync(path, JSON.stringify(snapshot));
		try {
			const adapter = new FleetSnapshotAdapter(dir);
			const first = adapter.poll("", "2026-07-13T00:00:01Z");
			expect(adapter.producerSubject).toBe("bridge:fleet");
			expect(first.emissions).toHaveLength(1);
			expect(first.emissions[0]).toMatchObject({
				type: "fleet.event.pre_tool",
				subject: "janet",
				task_id: 42,
				scope: "fleet",
			});
			expect(adapter.poll(first.cursor, "2026-07-13T00:00:02Z").emissions).toHaveLength(0);
			const restarted = adapter.poll("", "2026-07-13T00:00:03Z");
			expect(restarted.emissions[0]?.id).toBe(first.emissions[0]?.id);
			writeFileSync(
				path,
				JSON.stringify({ ...snapshot, event: "post_tool", status: "idle", task_id: null }),
			);
			expect(adapter.poll(first.cursor, "2026-07-13T00:00:04Z").emissions[0]?.type).toBe(
				"fleet.event.post_tool",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("samples unchanged manager keepalives at 15 seconds and emits state changes immediately", () => {
		const dir = mkdtempSync(join(tmpdir(), "console-manager-"));
		const path = join(dir, "janet-heartbeat.json");
		const heartbeat = {
			schema_version: 2,
			handle: "janet",
			state: "running",
			io_ok: true,
			crash_count: 0,
			updated_at_epoch: 1_784_070_400,
		};
		writeFileSync(path, JSON.stringify(heartbeat));
		try {
			const adapter = new ManagerHeartbeatAdapter(dir);
			const first = adapter.poll("", "2026-07-13T00:00:00Z");
			writeFileSync(path, JSON.stringify({ ...heartbeat, updated_at_epoch: 1_784_070_401 }));
			const oneSecond = adapter.poll(first.cursor, "2026-07-13T00:00:01Z");
			expect(oneSecond.emissions).toHaveLength(0);
			const keepalive = adapter.poll(oneSecond.cursor, "2026-07-13T00:00:15Z");
			expect(keepalive.emissions[0]?.type).toBe("agent.heartbeat");
			writeFileSync(
				path,
				JSON.stringify({ ...heartbeat, state: "crashed", updated_at_epoch: 1_784_070_416 }),
			);
			expect(adapter.poll(keepalive.cursor, "2026-07-13T00:00:16Z").emissions[0]).toMatchObject({
				type: "agent.crashed",
				severity: "danger",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tails subsystem JSONL spools, maps RPC envelopes, and skips stable poison", () => {
		const dir = mkdtempSync(join(tmpdir(), "console-spool-"));
		writeFileSync(
			join(dir, "control-plane.jsonl"),
			`${JSON.stringify({
				schema_version: 1,
				id: "11111111-2222-4333-8444-555555555555",
				type: "event",
				method: "governance.action",
				agent: "janet",
				ts: "2026-07-13T00:00:00Z",
				payload: { action: "throttle", delay_ms: 60_000 },
			})}\n{bad json}\n`,
		);
		try {
			const adapter = new JsonlSpoolAdapter(
				"control-plane",
				"bridge:control-plane",
				"control-plane",
				dir,
			);
			const batch = adapter.poll("", "2026-07-13T00:00:01Z");
			expect(batch.emissions[0]).toMatchObject({
				type: "governance.action",
				source: { service: "control-plane", agent: "janet" },
				subject: "janet",
				scope: "fleet",
			});
			expect(batch.losses).toEqual([{ cursor: "control-plane.jsonl:2", reason: "invalid_json" }]);
			expect(adapter.poll(batch.cursor, "2026-07-13T00:00:02Z").emissions).toHaveLength(0);
			writeFileSync(
				join(dir, "control-plane.jsonl"),
				`${JSON.stringify({
					id: "22222222-3333-4444-8555-666666666666",
					method: "fleet.mode",
					agent: "janet",
					ts: "2026-07-13T00:00:03Z",
					payload: { mode: "sequential" },
				})}\n`,
				{ flag: "a" },
			);
			expect(adapter.poll(batch.cursor, "2026-07-13T00:00:03Z").emissions[0]?.type).toBe(
				"fleet.mode",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads dispatcher card state through a fenced read-only SQLite cursor", () => {
		const dir = mkdtempSync(join(tmpdir(), "console-dispatcher-"));
		const path = join(dir, "dispatcher.db");
		const db = new DatabaseSync(path);
		db.exec(`create table cards (
			card_id text primary key, task_id integer, sender text, sender_class text,
			recipient text, priority integer, thread text, body text, requires_reply integer,
			interrupt_policy text, needs text, state text, claimed_by text, fence integer,
			reaps integer, reply_to text, parent_id text, delivered integer, addressed integer,
			created_at_ms integer, updated_at_ms integer
		)`);
		db.prepare(
			`insert into cards values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"card-1",
			42,
			"parker",
			"principal",
			"janet",
			0,
			null,
			"Verify the dispatcher correspondence path.",
			1,
			"principal_command",
			"[]",
			"claimed",
			"janet",
			2,
			0,
			null,
			null,
			1,
			1,
			1_784_070_400_000,
			1_784_070_401_000,
		);
		db.close();
		try {
			const adapter = new DispatcherSqliteAdapter(path);
			const first = adapter.poll("", "2026-07-13T00:00:02Z");
			expect(adapter.producerSubject).toBe("bridge:dispatcher");
			expect(first.emissions[0]).toMatchObject({
				type: "card.state_changed",
				subject: "card-1",
				task_id: 42,
				severity: "danger",
				dimensions: { state: "claimed", claimed_by: "janet" },
			});
			expect(first.emissions[1]).toMatchObject({
				type: "comms.card",
				source: { service: "dispatcher", agent: "parker" },
				subject: "janet",
				task_id: 42,
				dimensions: { card_id: "card-1", method: "task.dispatch", requires_reply: true },
				meta: { body_preview: "Verify the dispatcher correspondence path." },
			});
			expect(
				parseEmission(first.emissions[1], Buffer.byteLength(JSON.stringify(first.emissions[1]))).ok,
			).toBe(true);
			expect(adapter.poll(first.cursor, "2026-07-13T00:00:03Z").emissions).toHaveLength(0);
			const concurrent = new DatabaseSync(path);
			concurrent
				.prepare(
					`insert into cards values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"card-0",
					43,
					"eli",
					"principal",
					"chidi",
					1,
					null,
					"Pick up task 43.",
					0,
					"defer",
					"[]",
					"posted",
					null,
					0,
					0,
					null,
					null,
					0,
					1,
					1_784_070_400_000,
					1_784_070_401_000,
				);
			concurrent.close();
			expect(adapter.poll(first.cursor, "2026-07-13T00:00:04Z").emissions[0]?.subject).toBe(
				"card-0",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries torn JSONL tails and replays same-length file replacements", () => {
		const dir = mkdtempSync(join(tmpdir(), "console-spool-durability-"));
		const path = join(dir, "janet.outbox.jsonl");
		const envelope = {
			id: "33333333-4444-4555-8666-777777777777",
			method: "agent.capacity",
			agent: "janet",
			ts: "2026-07-13T00:00:00Z",
			payload: { free_slots: 1 },
		};
		writeFileSync(path, JSON.stringify(envelope));
		try {
			const adapter = new JsonlSpoolAdapter("box-agent", "bridge:box-agent", "box-agent", dir);
			const torn = adapter.poll("", "2026-07-13T00:00:01Z");
			expect(torn.emissions).toHaveLength(0);
			writeFileSync(path, "\n", { flag: "a" });
			const completed = adapter.poll(torn.cursor, "2026-07-13T00:00:02Z");
			expect(completed.emissions[0]?.type).toBe("agent.capacity");
			writeFileSync(
				path,
				`${JSON.stringify({ ...envelope, id: "44444444-5555-4666-8777-888888888888", method: "worker.inventory" })}\n`,
			);
			const replaced = adapter.poll(completed.cursor, "2026-07-13T00:00:03Z");
			expect(replaced.losses).toEqual([{ cursor: "janet.outbox.jsonl:1", reason: "cursor_reset" }]);
			expect(replaced.emissions[0]?.type).toBe("worker.inventory");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("quarantines an oversized JSONL record and resumes at the following record", () => {
		const dir = mkdtempSync(join(tmpdir(), "console-spool-oversize-"));
		const path = join(dir, "janet.outbox.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ payload: "x".repeat(1024 * 1024) })}\n${JSON.stringify({
				id: "55555555-6666-4777-8888-999999999999",
				method: "agent.capacity",
				agent: "janet",
				ts: "2026-07-13T00:00:00Z",
				payload: { free_slots: 2 },
			})}\n`,
		);
		try {
			const adapter = new JsonlSpoolAdapter("box-agent", "bridge:box-agent", "box-agent", dir);
			const skipped = adapter.poll("", "2026-07-13T00:00:01Z");
			expect(skipped.losses).toEqual([{ cursor: "janet.outbox.jsonl:1", reason: "oversize" }]);
			expect(skipped.emissions).toHaveLength(0);
			expect(adapter.poll(skipped.cursor, "2026-07-13T00:00:02Z").emissions[0]?.type).toBe(
				"agent.capacity",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
