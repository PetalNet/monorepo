import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { readBoundedFd, sourceCursorRef, tailSystemOutbox } from "../src/bridge/system-outbox.ts";
import { uuidv5 } from "../src/bridge/uuid5.ts";

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
		const source = Buffer.from('{"sender":"shawn","body":"ok"}');
		const bytes = readBoundedFd(42, (_fd, target, offset, length, position) => {
			if (position >= source.length) return 0;
			const count = Math.min(3, length, source.length - position);
			source.copy(target, offset, position, position + count);
			return count;
		});
		expect(bytes?.toString("utf8")).toBe(source.toString("utf8"));
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
