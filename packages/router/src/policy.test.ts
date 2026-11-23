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
