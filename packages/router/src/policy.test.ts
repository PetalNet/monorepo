import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";

import { testAdapter } from "../test/adapter.ts";
import { hasCredentials, launch, redact } from "./adapters.ts";
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
	pools: POOLS.map(({ service: _service, ...p }) => p),
	blocks: [],
	floorPct: 15,
	runnableOnly: true,
};

it("rejects a provider claiming another provider's privacy and quota pool", () => {
	const result = pick(catalog, "code", "*", state);

	expect(result.ranked).toEqual([]);
	expect(result.excluded[0]?.reasons).toContain("provider and execution pool do not match");
	const offer = offersFrom(catalog, "code", POOLS)[0];

	if (!offer) {
		throw new Error("fixture has no offer");
	}

	expect(() => launch(offer, "brief", tmpdir())).toThrow(
		"provider and execution pool do not match",
	);
});

it.each([
	"xoxb-example-secret",
	JSON.stringify({ task: `line one\nghp_${"a".repeat(36)}` }),
	"Authorization: Bearer example-secret",
	"token = 'example secret'",
	"-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
])("classifies credentials using the redactor's same detector: %s", (credential) => {
	expect(hasCredentials(credential)).toBe(true);
	expect(redact(credential)).not.toBe(credential);

	const eligible = pick(
		{ models: [{ id: "gemini-test", provider: "gemini", score: 60 }], tiers: { C: 0 } },
		"code",
		"*",
		{ ...state, dataClass: effectiveDataClass("public", credential) },
	);

	expect(eligible.ranked).toEqual([]);
	expect(effectiveDataClass("public", credential)).toBe("sensitive");
	expect(effectiveDataClass("parcs", credential)).toBe("parcs");
});

it("passes the next nesting depth to a real child and refuses a fifth launch", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-depth-"));

	dirs.push(dir);
	const marker = path.join(dir, "depth");

	await writeFile(path.join(dir, "codex"), testAdapter, { mode: 0o700 });

	vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
	vi.stubEnv("MARKER", marker);
	vi.stubEnv("ROUTE_DEPTH", "3");

	const offer = offersFrom(
		{ models: [{ id: "gpt-test", provider: "codex", score: 50 }], tiers: {} },
		"code",
		POOLS,
	)[0];

	if (!offer) {
		throw new Error("fixture has no offer");
	}

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

	await writeFile(path.join(dir, "codex"), testAdapter, { mode: 0o700 });

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
		.map((line): unknown => JSON.parse(line));

	expect(rows).toContainEqual(
		expect.objectContaining({
			event: "launch",
			briefHash: createHash("sha256").update(brief).digest("hex"),
		}),
	);

	const limited = spawnSync(process.execPath, [entry, "run", "gpt-test:low", file], {
		encoding: "utf8",
		env: { ...env, HOME: path.join(dir, "absent"), ROUTE_DEPTH: "4" },
	});

	expect(limited.status).toBe(4);
	expect(limited.stderr).toContain("nesting limit");

	const reordered = spawnSync(
		process.execPath,
		[entry, "--class", "parcs", "run", "gpt-test:low", file],
		{ encoding: "utf8", env: { ...env, ROUTE_DEPTH: "4" } },
	);

	expect(reordered.status).toBe(4);
	expect(reordered.stderr).toContain("nesting limit");
});

it("excludes the parent's canonical model identity across provider aliases", () => {
	const models: Catalog = {
		models: [
			{ id: "sonnet", provider: "claude", score: 55 },
			{ id: "claude-sonnet-5-5", provider: "agy-claude", score: 55 },
		],
		tiers: { C: 0 },
	};
	const result = pick(models, "code", "*", {
		...state,
		dataClass: "public",
		notModel: ["sonnet"],
		pools: state.pools.map(({ explicitOnly: _explicitOnly, ...pool }) => pool),
	});

	expect(result.ranked).toEqual([]);

	expect(
		result.excluded.every((r) => r.reasons.some((reason) => reason.includes("wrote the work"))),
	).toBe(true);
});

it("refuses a superseded CLI run and logs a reproducibility override without bypassing policy", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-supersession-"));

	dirs.push(dir);
	const shared = path.join(dir, ".claude/shared");
	const old = "gpt-6-sol";
	const replacement = "gpt-6.2-sol";

	await mkdir(shared, { recursive: true });

	await writeFile(
		path.join(shared, "model-tiers.json"),
		JSON.stringify({
			models: [old, replacement].map((id) => ({ id, provider: "codex", score: 50 })),
			tiers: { C: 0 },
		}),
	);

	await writeFile(
		path.join(shared, "aa-models.json"),
		JSON.stringify({
			fetchedAt: new Date().toISOString(),
			models: [old, replacement].map((slug) => ({
				slug,
				release: { slug },
				effort: { slug: "low" },
				intelligenceIndexCostPerTask: { cost: { total: 1 } },
			})),
		}),
	);

	await writeFile(path.join(dir, "codex"), testAdapter, { mode: 0o700 });

	const entry = fileURLToPath(new URL("route.ts", import.meta.url));
	const route = (...args: string[]) =>
		spawnSync(process.execPath, [entry, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: dir,
				PATH: `${dir}:${process.env["PATH"] ?? ""}`,
				QUOTA_CODEX_CMD: "true",
				QUOTA_AGY_CMD: "true",
				QUOTA_CLAUDE_USAGE_CMD: "true",
				ROUTE_NO_INJECT: "1",
				ROUTE_DEPTH: "0",
				ROUTE_PARENT_MODEL: "gpt-6.2-astra",
			},
		});
	const target = `${old}:low`;
	const brief = "Reply with the captured brief.";
	const ledger = path.join(dir, ".local/state/router/ledger.jsonl");
	const blocked = route("run", target, brief);

	expect(blocked.status).toBe(3);
	expect(blocked.stdout).toContain(`superseded by ${replacement}:low`);
	expect(blocked.stdout).toContain("--allow-superseded");

	const sameVendor = route("run", target, "--not-vendor", "openai", brief);

	expect(sameVendor.status).toBe(3);
	expect(sameVendor.stdout).toContain("falling back to the best different model");
	expect(sameVendor.stdout).toContain(`superseded by ${replacement}:low`);
	await expect(readFile(ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

	const why = route("why", target);

	expect(why.status).toBe(3);
	expect(why.stdout).toContain(`${target} [codex] blocked: superseded by ${replacement}:low`);
	expect(route("ls", "--allow-superseded").status).toBe(2);

	const override = route("run", target, "--allow-superseded", brief);

	expect(override.status).toBe(0);
	expect(override.stdout).toContain(brief);

	const log = await readFile(ledger, "utf8");
	const events = log
		.trim()
		.split("\n")
		.map((line): unknown => JSON.parse(line));

	expect(events).toContainEqual(
		expect.objectContaining({
			event: "launch",
			model: old,
			effort: "low",
			supersessionOverride: `${replacement}:low`,
		}),
	);

	const legacy = path.join(dir, ".local/state/agy-build");

	await mkdir(legacy, { recursive: true });
	await writeFile(path.join(legacy, "pools.json"), JSON.stringify({ deny_patterns: [old] }));
	const denied = route("run", target, "--allow-superseded", brief);

	expect(denied.status).toBe(3);
	expect(denied.stdout).toContain("denied in pools.json");
	await writeFile(path.join(legacy, "pools.json"), "{}");
	const capped = route("run", `${old}:xhigh`, "--allow-superseded", brief);

	expect(capped.status).toBe(3);
	expect(capped.stdout).toContain("effort xhigh not allowed");
	expect(await readFile(ledger, "utf8")).toBe(log);
});
