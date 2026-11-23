import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { launch } from "./adapters.ts";
import { CODEX_EFFORTS, supportedEfforts } from "./effort.ts";
import { POOLS, type Offer } from "./pick.ts";
import { testAdapter } from "./test-adapter.ts";

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

const offer: Offer = {
	id: "gpt-test",
	model: "gpt-test",
	provider: "codex",
	effort: "low",
	family: "gpt",
	origin: "us",
	score: 1,
	bonus: 0,
	pool: POOLS.find((pool) => pool.id === "codex"),
};

it.each(CODEX_EFFORTS)(
	"passes Codex %s explicitly without executing brief text",
	async (effort) => {
		const cwd = await adapter("codex");
		const brief = "literal $(exit 19) and 'quotes'";
		const result = await launch({ ...offer, effort }, brief, cwd);

		expect(result.code).toBe(0);
		expect(result.out).toContain(`-c\nmodel_reasoning_effort=${effort}\n`);
		expect(result.out).toContain(`-m\ngpt-test\n`);
		expect(result.out).toContain(`-\n${brief}`);
	},
);

it("keeps agy slug and effort consistent even when the catalog ID encoded another level", async () => {
	const cwd = await adapter("agy");
	const result = await launch(
		{
			...offer,
			provider: "gemini",
			pool: POOLS.find((pool) => pool.id === "google-ai:gemini"),
			model: "gemini-4-neon",
			id: "gemini-4-neon-xhigh",
			effort: "low",
		},
		"brief",
		cwd,
	);

	expect(result.code).toBe(0);
	expect(result.out).toContain("--model\ngemini-4-neon-low\n--effort\nlow\n");
	expect(result.out).not.toContain("xhigh");
});

it("offers only published agy variants and preserves fixed-budget models", () => {
	expect(supportedEfforts("gemini", "gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
	expect(supportedEfforts("gemini", "gemini-4-argon")).toEqual(["low", "medium", "high"]);
	expect(supportedEfforts("agy-gpt", "gpt-oss-120b")).toEqual(["medium"]);
	expect(supportedEfforts("gemini", "gemini-pro-orchestrator-neon")).toEqual(["default"]);
	expect(supportedEfforts("gemini", "unknown-model", "high")).toEqual(["high"]);
});
