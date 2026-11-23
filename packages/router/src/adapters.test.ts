import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { testAdapter } from "../test/adapter.ts";
import { launch } from "./adapters.ts";
import { resolveTarget } from "./policy.ts";

const dirs: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function adapter(name: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "router-adapter-"));

	dirs.push(dir);
	await writeFile(path.join(dir, name), testAdapter, { mode: 0o700 });
	vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);

	return dir;
}

function target(id: string) {
	const resolved = resolveTarget(id);

	if (!resolved) {
		throw new Error("missing test target");
	}

	return resolved;
}

it.each(["none", "low", "medium", "high"])(
	"passes Codex %s explicitly without executing brief text",
	async (effort) => {
		const cwd = await adapter("codex");
		const brief = "literal $(exit 19) and 'quotes'";
		const result = await launch(target(`gpt-test:${effort}`), brief, cwd);

		expect(result.code).toBe(0);
		expect(result.out).toContain(`-c\nmodel_reasoning_effort=${effort}\n`);
		expect(result.out).toContain(`-m\ngpt-test\n`);
		expect(result.out).toContain(`-\n${brief}`);
	},
);

it("passes the same agy effort in the slug and flag", async () => {
	const cwd = await adapter("agy");
	const result = await launch(target("gemini-4-neon:low"), "brief", cwd);

	expect(result.code).toBe(0);
	expect(result.out).toContain("--model\ngemini-4-neon-low\n--effort\nlow\n");
});
