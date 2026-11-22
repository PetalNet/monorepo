import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";

import { hasCredentials, launch } from "./adapters.ts";
import { offersFrom, pick, POOLS, type Catalog, type State } from "./pick.ts";
import { effectiveDataClass } from "./route.ts";

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const catalog: Catalog = {
	models: [{ id: "gemini-test", provider: "gemini", pool: "codex", score: 60 }],
	tiers: { S: 57, C: 0 },
};
const state: State = {
	nowMs: Date.now(),
	dataClass: "sensitive",
	reports: {},
	exhausted: {},
	deny: [],
	denyPatterns: [],
	pools: POOLS.map(({ service: _, ...p }) => p),
	blocks: [],
	floorPct: 15,
	runnableOnly: true,
};

it("rejects a provider claiming another provider's privacy and quota pool", async () => {
	const result = pick(catalog, "code", "*", state);
	expect(result.ranked).toEqual([]);
	expect(result.excluded[0]?.reasons).toContain("provider and execution pool do not match");
	const offer = offersFrom(catalog, "code", POOLS)[0]!;
	expect(() => launch(offer, "brief", tmpdir())).toThrow(
		"provider and execution pool do not match",
	);
});

it.each([
	"xoxb-example-secret",
	"Authorization: Bearer example-secret",
	"token = 'example secret'",
	"-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
])("classifies credentials using the redactor's same detector: %s", (credential) => {
	expect(hasCredentials(credential)).toBe(true);
	expect(effectiveDataClass("public", credential)).toBe("sensitive");
	expect(effectiveDataClass("parcs", credential)).toBe("parcs");
});

it("passes the next nesting depth to a real child and refuses a fifth launch", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-depth-"));
	dirs.push(dir);
	const marker = path.join(dir, "depth");
	await writeFile(
		path.join(dir, "codex"),
		'#!/bin/sh\nprintf "%s" "$ROUTE_DEPTH" > "$MARKER"\ncat\n',
		{ mode: 0o700 },
	);
	vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
	vi.stubEnv("MARKER", marker);
	vi.stubEnv("ROUTE_DEPTH", "3");
	const offer = offersFrom(
		{ models: [{ id: "gpt-test", provider: "codex", score: 50 }], tiers: {} },
		"code",
		POOLS,
	)[0]!;
	expect((await launch(offer, "literal brief", dir)).out).toBe("literal brief");
	expect(await readFile(marker, "utf8")).toBe("4");
	vi.stubEnv("ROUTE_DEPTH", "4");
	expect(() => launch(offer, "brief", dir)).toThrow("nesting limit");
});

it("sends and hashes captured task-file contents and rejects excessive depth before any reader", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-file-"));
	dirs.push(dir);
	await mkdir(path.join(dir, ".claude/shared"), { recursive: true });
	await writeFile(
		path.join(dir, ".claude/shared/model-tiers.json"),
		JSON.stringify({ models: [{ id: "gpt-test", provider: "codex", score: 50 }], tiers: { C: 0 } }),
	);
	const brief = "Return the captured task contents.";
	const file = path.join(dir, "brief.md");
	await writeFile(file, brief);
	const reader = path.join(dir, "reader");
	await writeFile(reader, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	await writeFile(path.join(dir, "codex"), '#!/bin/sh\ncase "$1" in --version|debug) exit 1;; esac\ncat\n', { mode: 0o700 });
	const env = {
		...process.env,
		HOME: dir,
		PATH: `${dir}:${process.env["PATH"] ?? ""}`,
		QUOTA_CODEX_CMD: reader,
		QUOTA_AGY_CMD: reader,
		QUOTA_CLAUDE_USAGE_CMD: reader,
		ROUTE_NO_INJECT: "1",
		ROUTE_DEPTH: "0",
	};
	const entry = fileURLToPath(new URL("route.ts", import.meta.url));
	const result = spawnSync(process.execPath, [entry, "run", "gpt-test:low", file], {
		encoding: "utf8",
		env,
	});
	expect(result.status).toBe(0);
	expect(result.stdout).toContain(brief);
	const rows = (await readFile(path.join(dir, ".local/state/router/ledger.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(rows.find((r) => r.event === "launch").briefHash).toBe(
		createHash("sha256").update(brief).digest("hex"),
	);
	const limited = spawnSync(process.execPath, [entry, "run", "gpt-test:low", file], {
		encoding: "utf8",
		env: { ...env, HOME: path.join(dir, "absent"), ROUTE_DEPTH: "4" },
	});
	expect(limited.status).toBe(4);
	expect(limited.stderr).toContain("nesting limit");
});
