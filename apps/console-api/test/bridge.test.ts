import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { tailSystemOutbox } from "../src/bridge/system-outbox.ts";
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
});

describe("system-outbox tailer", () => {
	it("maps bot warnings to bot.message emissions with severity from the prefix", () => {
		const dir = makeOutbox({
			"100-shawn.json": { sender: "shawn", body: "[warn] host-janitor: .14 disk 91% used" },
			"101-derek.json": { sender: "derek", body: "[fail] container update stuck" },
			"102-michael.json": { sender: "michael", body: "board digest ready" },
		});
		try {
			const { emissions, cursor } = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(emissions).toHaveLength(3);
			expect(emissions.map((e) => e.type)).toEqual(["bot.message", "bot.message", "bot.message"]);
			// the SUBJECT is the trustworthy source, not the (spoofable) claimed sender
			expect(new Set(emissions.map((e) => e.subject))).toEqual(new Set(["system-outbox"]));
			const bySender = (s: string) => emissions.find((e) => e.dimensions?.["sender"] === s);
			expect(bySender("shawn")?.severity).toBe("warn");
			expect(bySender("derek")?.severity).toBe("danger");
			expect(bySender("michael")?.severity).toBe("info");
			expect(cursor).toBe("102-michael.json");
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
			const second = tailSystemOutbox(dir, first.cursor, first.belowCount, "2026-07-13T00:00:01Z");
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

	it("treats a partial/corrupt file as a barrier — later files are not skipped forever", () => {
		const dir = makeOutbox({ "100-shawn.json": { sender: "shawn", body: "[warn] a" } });
		// a file caught mid-write: invalid JSON, sorts between the two valid ones
		writeFileSync(join(dir, "sent", "150-derek.json"), '{"sender":"derek","body":"[fail] par');
		writeFileSync(
			join(dir, "sent", "200-shawn.json"),
			JSON.stringify({ sender: "shawn", body: "[warn] b" }),
		);
		try {
			// first poll stops at the corrupt file: only 100 emits, cursor stays before 150
			const first = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(first.emissions).toHaveLength(1);
			expect(first.cursor).toBe("100-shawn.json");
			// the bot finishes writing 150; re-poll picks it up AND the file behind it (no loss)
			writeFileSync(
				join(dir, "sent", "150-derek.json"),
				JSON.stringify({ sender: "derek", body: "[fail] parted" }),
			);
			const second = tailSystemOutbox(dir, first.cursor, first.belowCount, "2026-07-13T00:00:01Z");
			expect(second.emissions.map((e) => e.dimensions?.["sender"])).toEqual(["derek", "shawn"]);
			expect(second.cursor).toBe("200-shawn.json");
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
			const second = tailSystemOutbox(dir, first.cursor, first.belowCount, "2026-07-13T00:00:01Z");
			expect(second.anomaly).toBe(true);
			expect(second.emissions.map((e) => e.dimensions?.["file"])).toContain("150-derek.json");
			expect(second.belowCount).toBe(2);
			// next poll is quiet again — the anomaly is not re-triggered
			const third = tailSystemOutbox(dir, second.cursor, second.belowCount, "2026-07-13T00:00:02Z");
			expect(third.anomaly).toBe(false);
			expect(third.emissions).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("coerces wrong-typed fields instead of crashing the whole source", () => {
		const dir = makeOutbox({
			"100-x.json": { sender: 1, body: { nested: true } }, // both wrong types
			"200-y.json": { sender: "shawn", body: "[warn] ok" },
		});
		try {
			const { emissions } = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(emissions).toHaveLength(2); // neither throws; the bad record gets safe defaults
			expect(emissions[0]?.dimensions?.["sender"]).toBe("unknown");
			expect(emissions[0]?.severity).toBe("info");
			expect(emissions[1]?.dimensions?.["sender"]).toBe("shawn");
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
			const { emissions } = tailSystemOutbox(dir, "", 0, "2026-07-13T00:00:00Z");
			expect(emissions).toHaveLength(1); // the symlink is skipped, the real file is read
			expect(emissions[0]?.dimensions?.["file"]).toBe("200-real.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(secret, { recursive: true, force: true });
		}
	});
});
