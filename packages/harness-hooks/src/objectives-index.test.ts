// An invented ledger in the real one's shapes (titled items with state/next fields, dated log lines, a numbered
// backlog section). Every name here is made up.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { archivable, index, parse, prunePlan, render, verify } from "./objectives-index-ledger.ts";

const script = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(path.join(os.tmpdir(), "obj-"));

	dirs.push(d);

	return d;
};

afterAll(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
});

const pad = "x".repeat(600);
const LEDGER = [
	"# Open Objectives Ledger",
	"",
	"Format: **owner** · outcome · state · next action · waiting-on",
	"",
	"- **[#11] Widget rollout** · me · state: increment 1 done · next: run the demos · waiting-on: nothing",
	"- **Gizmo cutover** · ✅ DONE 2026-01-02 · prod on 2.0",
	"  1. sub-step kept with its item",
	"- **Form for Acme Corp** · me · WAITING on a new portal password",
	"- 01-03 01:51: frobnicator#2 MERGED abc1234 + DEPLOYED",
	"- 01-03: sent the list; Waiting on a go for the rest",
	"- **Demo site** · ✅ LIVE · next: add the QR page",
	...Array.from(
		{ length: 300 },
		(_, i) =>
			`- **Objective ${String(i)}** · me · state: ${i % 2 ? "ACTIVE" : "idea"} · next: step ${String(i)} ${pad}`,
	),
	"",
	"## ⭐ MASTER BACKLOG",
	"1. DONE channel lineup",
	"2. WAIT for a go",
	"",
].join("\n");

describe("ledger", () => {
	it("round-trips parse and render byte for byte", () => {
		expect(render(parse(LEDGER))).toBe(LEDGER);
	});

	it("makes ids stable and unique: tag, title slug, hash, and a ~N suffix for repeats", () => {
		const ids = parse("- **[#7] A thing** x\n- **Same** a\n- **Same** b\n- plain log line").flatMap(
			(b) => (b.id ? [b.id] : []),
		);

		expect(ids.slice(0, 3)).toEqual(["#7", "same", "same~2"]);
		expect(ids[3]).toMatch(/^h:[0-9a-f]{10}$/u);
	});

	it("archives only finished items with no open marker", () => {
		const items = new Map(
			parse(LEDGER)
				.filter((b) => b.kind === "item")
				.map((b): [string, boolean] => [b.id ?? "", archivable(b)]),
		);

		expect(items.get("gizmo-cutover")).toBe(true);
		expect(items.get("#11")).toBe(false);
		expect(items.get("form-for-acme-corp")).toBe(false);
		expect(items.get("demo-site"), "done but has a next step").toBe(false);

		const logs = parse(LEDGER)
			.filter((b) => b.kind === "item" && !b.title)
			.map(archivable);

		expect(logs, "a finished log line goes, one that is still waiting stays").toEqual([
			true,
			false,
		]);
	});

	it("keeps an unindented numbered sub-step with its item", () => {
		const item = parse("- **Thing** · DONE\n1. but this step is WAITING").find(
			(b) => b.kind === "item",
		);

		expect(item?.lines).toHaveLength(2);
		expect(item && archivable(item)).toBe(false);
	});

	it("fits the index in the cap, lists waiting/active work first, and counts what it leaves out", () => {
		const ix = index(parse(LEDGER), { path: "/l.md" });

		expect(Buffer.byteLength(ix)).toBeLessThanOrEqual(6000);
		const shown = ix.split("\n").filter((l) => l.startsWith("- "));

		expect(shown[0]).toMatch(/^- Objective 299 \| ACTIVE \| next: step 299/u);
		expect(shown.slice(0, 10).every((l) => /\| ACTIVE|\| WAITING/u.test(l))).toBe(true);
		const more = Number(/…(\d+) more titled entries/u.exec(ix)?.[1]);

		expect(shown.length + more).toBe(304);
		expect(ix).toMatch(/2 numbered master-backlog lines/u);
	});

	it("never splits an emoji when clipping, so the hook output stays valid JSON", () => {
		const ix = index(parse(`- **${"a".repeat(48)}🔄🔄🔄 long title** · WAITING`), {
			path: "/l.md",
		});

		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(ix), "no lone high surrogate").toBe(false);
	});

	it("catches a pruned output that drops an open item or a line", () => {
		const { newLedger, archived } = prunePlan(LEDGER);

		expect(verify(LEDGER, newLedger, archived).openDropped).toEqual([]);
		const tampered = newLedger.replace(/^- \*\*Form for Acme Corp\*\*.*\n/mu, "");
		const r = verify(LEDGER, tampered, archived);

		expect([r.lost, r.openDropped, r.linesKept]).toEqual([
			["form-for-acme-corp"],
			["form-for-acme-corp"],
			false,
		]);
	});
});

describe("sessionstart-objectives", () => {
	const run = (env: Record<string, string>) =>
		execFileSync(process.execPath, ["--no-warnings", script("./sessionstart-objectives.ts")], {
			env: { ...process.env, ...env },
		}).toString();

	it("injects the index, not the ledger", () => {
		const dir = tmp();

		writeFileSync(path.join(dir, "l.md"), LEDGER);
		const out = run({ OBJECTIVES_LEDGER: path.join(dir, "l.md"), TASK_OUTPUT_ROOTS: dir });
		const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } })
			.hookSpecificOutput.additionalContext;

		expect(LEDGER.length).toBeGreaterThan(150000);
		expect(ctx.length).toBeLessThan(8000);
		expect(ctx).toMatch(/Objective 299 \| ACTIVE/u);
	});

	it("lists background-agent output files changed in the last day", () => {
		const dir = tmp();
		const tasks = path.join(dir, "proj/tasks");

		execFileSync("mkdir", ["-p", tasks]);
		writeFileSync(path.join(tasks, "a1.output"), "x");
		const out = run({ OBJECTIVES_LEDGER: path.join(dir, "missing.md"), TASK_OUTPUT_ROOTS: dir });
		const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } })
			.hookSpecificOutput.additionalContext;

		expect(ctx).toContain("1 background-agent output file(s)");
		expect(ctx).toContain(path.join(tasks, "a1.output"));
	});

	it("prints nothing when there is no ledger and no task output", () => {
		const dir = tmp();

		expect(run({ OBJECTIVES_LEDGER: path.join(dir, "missing.md"), TASK_OUTPUT_ROOTS: dir })).toBe(
			"",
		);
	});
});

describe("objectives-prune", () => {
	const prune = (...args: string[]) =>
		execFileSync(process.execPath, ["--no-warnings", script("./objectives-prune.ts"), ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		}).toString();

	it("moves finished items to the archive and loses nothing", () => {
		const dir = tmp();
		const l = path.join(dir, "l.md");
		const a = path.join(dir, "a.md");

		writeFileSync(l, LEDGER);

		const report = JSON.parse(prune(l, a, "--write")) as {
			lost: string[];
			openDropped: string[];
			linesKept: boolean;
			archived: number;
		};

		expect([report.lost, report.openDropped, report.linesKept]).toEqual([[], [], true]);
		expect(report.archived).toBe(2);
		const live = readFileSync(l, "utf8");
		const arch = readFileSync(a, "utf8");

		expect(live).not.toContain("Gizmo cutover");
		expect(arch).toContain("  1. sub-step kept with its item");
		expect(live).toContain("Form for Acme Corp");
		expect(live).toContain("2. WAIT for a go");
	});

	it("only reports without --write", () => {
		const dir = tmp();
		const l = path.join(dir, "l.md");

		writeFileSync(l, LEDGER);
		prune(l, path.join(dir, "a.md"));

		expect(readFileSync(l, "utf8")).toBe(LEDGER);
	});

	it("exits 2 with usage when arguments are missing", () => {
		expect(() => prune()).toThrow(/status 2|Command failed/u);
	});
});
