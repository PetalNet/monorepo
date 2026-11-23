import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";

import { testAdapter } from "../test/adapter.ts";
import { hasCredentials, launch, redact } from "./adapters.ts";
import { classRefusal, effectiveDataClass, resolveTarget } from "./policy.ts";

const dirs: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function target(id: string) {
	const resolved = resolveTarget(id);

	if (!resolved) {
		throw new Error("missing test target");
	}

	return resolved;
}

it("keeps the privacy policy tied to the execution provider", () => {
	expect(classRefusal(target("gpt-6.2-sol:low"), "sensitive", false)).toBeUndefined();
	expect(classRefusal(target("gpt-6.2-sol:low"), "parcs", false)).toContain("claude plan only");

	expect(classRefusal(target("gemini-4-neon:low"), "sensitive", false)).toContain(
		"training opt-out",
	);

	expect(classRefusal(target("claude-opus-5-5-high"), "parcs", false)).toContain(
		"claude plan only",
	);

	expect(classRefusal(target("claude-opus-5-5-high"), "sensitive", false)).toContain(
		"training opt-out",
	);

	expect(classRefusal(target("opus:high"), "parcs", false)).toBeUndefined();
	expect(classRefusal(target("opus:high"), "public", false)).toContain("explicit-use");
	expect(resolveTarget("gemini-4-neon-xhigh:low")).toBeUndefined();
	expect(resolveTarget("gpt-6.2-sol:ultra")).toBeUndefined();
	expect(target("claude-opus-5-5:high").pool.id).toBe("google-ai:claude-gpt");
	expect(resolveTarget("claude-opus-5-5-high", true)?.pool.id).toBe("claude");
	expect(() => launch(target("opus:high"), "brief", tmpdir())).toThrow("no execution adapter");
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

	const offer = target("gpt-test:low");

	expect((await launch(offer, "literal brief", dir)).out).toBe("literal brief");
	expect(await readFile(marker, "utf8")).toBe("4");
	vi.stubEnv("ROUTE_DEPTH", "4");
	expect(() => launch(offer, "brief", dir)).toThrow("nesting limit");
});

it("sends and hashes captured task-file contents and rejects excessive depth before any reader", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-file-"));

	dirs.push(dir);
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

it("refuses a scanned brief and records the notification before any builder starts", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-refusal-"));

	dirs.push(dir);
	const entry = fileURLToPath(new URL("route.ts", import.meta.url));
	const result = spawnSync(
		process.execPath,
		[
			entry,
			"run",
			"gemini-4-neon:low",
			"--for",
			"legacy-kind",
			"Authorization: Bearer example-secret",
		],
		{ encoding: "utf8", env: { ...process.env, HOME: dir, ROUTE_DEPTH: "0" } },
	);

	expect(result.status).toBe(3);
	expect(result.stdout).toContain("class raised to sensitive");
	expect(result.stdout).toContain("launch refused; inject=queued");
	expect(result.stderr).toContain("training opt-out");
	const ledger = await readFile(path.join(dir, ".local/state/router/ledger.jsonl"), "utf8");

	expect(ledger).not.toContain("example-secret");

	expect(JSON.parse(ledger)).toMatchObject({
		event: "inject",
		exitCode: 0,
		status: "launch refused",
	});
});

it.each([
	{ flags: ["--kind", "code"], dataClass: "public" },
	{ flags: ["--tier", "S"], dataClass: "public" },
	{ flags: ["--for", "research"], dataClass: "public" },
	{ flags: ["--allow-superseded"], dataClass: "public" },
	{ flags: ["--data-class", "sensitive"], dataClass: "sensitive" },
	{ flags: [], dataClass: "public" },
	{ flags: ["--not-vendor", "OpenAI"], dataClass: "public", model: "gemini-4-neon" },
	{ flags: [], dataClass: "public", used: 100, model: "gemini-4-neon" },
	{ flags: ["--data-class", "sensitive"], dataClass: "sensitive", used: 100, refused: true },
	{
		flags: ["--kind", "code", "--tier", "A", "--data-class", "public", "--allow-superseded"],
		dataClass: "public",
	},
])("selects a default using current quota for $flags (used: $used)", async (scenario) => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-default-"));

	dirs.push(dir);
	const now = Date.UTC(2026, 10, 23, 18);
	const reset = new Date(now + 2 * 60 * 60 * 1000).toISOString();
	const weekReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
	const clock = path.join(dir, "clock.mjs");
	const codexQuota = path.join(dir, "codex-quota");
	const agyQuota = path.join(dir, "agy-quota");

	await Promise.all([
		writeFile(clock, `Date.now = () => ${String(now)};\n`),
		writeFile(path.join(dir, "codex"), testAdapter, { mode: 0o700 }),
		writeFile(path.join(dir, "agy"), testAdapter, { mode: 0o700 }),
		writeFile(
			codexQuota,
			`#!/bin/sh\necho '${JSON.stringify({
				id: 2,
				result: {
					rateLimits: {
						planType: "prolite",
						primary: {
							usedPercent: scenario.used ?? 0,
							windowDurationMins: 10080,
							resetsAt: Date.parse(weekReset) / 1000,
						},
					},
				},
			})}'\n`,
			{ mode: 0o700 },
		),
		writeFile(
			agyQuota,
			`#!/bin/sh\nprintf '%s\\n' 'Gemini Models\t5h\t98%\t${reset}' 'Gemini Models\t7d\t98%\t${weekReset}'\n`,
			{ mode: 0o700 },
		),
	]);

	const brief = "Return a harmless marker.";
	const entry = fileURLToPath(new URL("route.ts", import.meta.url));
	const result = spawnSync(process.execPath, [entry, "run", ...scenario.flags, brief], {
		encoding: "utf8",
		timeout: 5000,
		env: {
			...process.env,
			HOME: dir,
			PATH: `${dir}:${process.env["PATH"] ?? ""}`,
			NODE_OPTIONS: `--import ${clock}`,
			CODEX_BIN: codexQuota,
			QUOTA_CODEX_CMD: "false",
			QUOTA_AGY_CMD: agyQuota,
			ROUTE_NO_INJECT: "1",
			ROUTE_DEPTH: "0",
		},
	});

	if (scenario.refused) {
		expect(result.stderr).toContain("no eligible default model");
		expect(result.status).toBe(3);

		return;
	}

	const model = scenario.model ?? "gpt-6.2-sol";

	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(result.stdout).toContain(`selected ${model}:high`);
	expect(result.stdout).toContain(brief);
	const ledger = await readFile(path.join(dir, ".local/state/router/ledger.jsonl"), "utf8");

	expect(
		ledger
			.split("\n")
			.filter(Boolean)
			.map((line): unknown => JSON.parse(line)),
	).toContainEqual(
		expect.objectContaining({
			event: "launch",
			model,
			effort: "high",
			dataClass: scenario.dataClass,
		}),
	);
});

it.each([
	{ flags: ["--data-class", "parcs"], brief: "Read the draft.", code: 5 },
	{ flags: ["--class", "confidential"], brief: "Read the draft.", code: 5 },
	{ flags: ["--class", "public"], brief: "Review the Bridgeton draft.", code: 5 },
	{
		flags: ["--data-class", "parcs", "--not-vendor", "anthropic"],
		brief: "Read the draft.",
		code: 3,
	},
])("keeps confidential defaults on native Claude for $flags", async ({ flags, brief, code }) => {
	const dir = await mkdtemp(path.join(tmpdir(), "route-handoff-"));

	dirs.push(dir);
	const entry = fileURLToPath(new URL("route.ts", import.meta.url));
	const result = spawnSync(process.execPath, [entry, "run", ...flags, brief], {
		encoding: "utf8",
		env: { ...process.env, HOME: dir, ROUTE_NO_INJECT: "1", ROUTE_DEPTH: "0" },
	});

	expect(result.status).toBe(code);

	if (code === 5) {
		expect(result.stdout).toContain("Claude handoff:");
		expect(result.stdout).toContain("selected opus:high");
	} else {
		expect(result.stderr).toContain("no eligible default model");
	}

	const ledger = await readFile(path.join(dir, ".local/state/router/ledger.jsonl"), "utf8");

	expect(ledger).not.toContain('"event":"launch"');
});
