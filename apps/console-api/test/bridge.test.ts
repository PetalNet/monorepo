import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
			const { emissions, cursor } = tailSystemOutbox(dir, "", "2026-07-13T00:00:00Z");
			expect(emissions).toHaveLength(3);
			expect(emissions.map((e) => e.type)).toEqual(["bot.message", "bot.message", "bot.message"]);
			expect(emissions.find((e) => e.subject === "shawn")?.severity).toBe("warn");
			expect(emissions.find((e) => e.subject === "derek")?.severity).toBe("danger");
			expect(emissions.find((e) => e.subject === "michael")?.severity).toBe("info");
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
			const first = tailSystemOutbox(dir, "", "2026-07-13T00:00:00Z");
			expect(first.emissions).toHaveLength(2);
			// re-poll from the advanced cursor: nothing new
			const second = tailSystemOutbox(dir, first.cursor, "2026-07-13T00:00:01Z");
			expect(second.emissions).toHaveLength(0);
			// re-tailing the SAME file yields the SAME id (lake dedups) — deterministic
			const reid = tailSystemOutbox(dir, "100-shawn.json", "2026-07-13T00:00:02Z");
			expect(reid.emissions[0]?.id).toBe(uuidv5("system-outbox:200-shawn.json"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws when the source directory is unreadable (caller emits unreachable)", () => {
		expect(() => tailSystemOutbox("/no/such/outbox", "", "2026-07-13T00:00:00Z")).toThrow();
	});
});
