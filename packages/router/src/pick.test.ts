import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServiceReport } from "@petalnet/harness-hooks/quota-sources";
import { describe, expect, it } from "vitest";

import { BLOCKS, type Catalog, type Pool, POOLS, type State, pick } from "./pick.ts";
import { effectiveDataClass, readBrief } from "./route.ts";

const NOW = Date.parse("2026-11-19T21:00:00Z");
const TIERS = { S: 57, A: 52, B: 46, C: 0 };

const catalog: Catalog = {
	tiers: TIERS,
	models: [
		{ id: "gemini-4-neon-xhigh", provider: "gemini", score: 61, good: { code: 3 } },
		{ id: "gemini-4-neon-low", provider: "gemini", score: 50 },
		{ id: "gpt-6-astra", provider: "codex", score: 61, good: { code: 3 } },
		{ id: "gpt-6.1-sol", provider: "codex", score: 58 },
		{ id: "claude-sonnet-5-5-high", provider: "agy-claude", score: 55 },
		{ id: "opus", provider: "claude", score: 59 },
		{ id: "fable-max", provider: "claude", score: 65 },
		{ id: "claude-fable-5-2", provider: "claude", score: 64 },
	],
};

function google(used: number): ServiceReport {
	return {
		service: "google-ai",
		status: "ok",
		summary: "",
		limits: [
			{ id: "google-ai:gemini-models:5h", label: "", usedPct: used, resetLabel: "17:34" },
			{ id: "google-ai:gemini-models:7d", label: "", usedPct: 30 },
			{ id: "google-ai:claude-and-gpt-models:5h", label: "", usedPct: 20 },
			{ id: "google-ai:claude-and-gpt-models:7d", label: "", usedPct: 50 },
		],
	};
}

const codex: ServiceReport = {
	service: "codex",
	status: "ok",
	summary: "",
	limits: [{ id: "codex:5h", label: "", usedPct: 40 }],
};

function state(over: Partial<State> = {}): State {
	return {
		nowMs: NOW,
		dataClass: "public",
		reports: { "google-ai": google(10), codex },
		exhausted: {},
		deny: [],
		denyPatterns: [],
		pools: POOLS,
		blocks: BLOCKS,
		floorPct: 15,
		...over,
	};
}

const ids = (result: ReturnType<typeof pick>) => result.ranked.map((r) => r.offer.id);
const models = (result: ReturnType<typeof pick>) => [
	...new Set(result.ranked.map((r) => r.offer.model)),
];
const why = (result: ReturnType<typeof pick>, id: string) =>
	result.excluded.find((e) => e.offer.id === id)?.reasons.join("; ") ?? "";

describe("pick", () => {
	it("runs only the caller's choice", () => {
		const result = pick(
			catalog,
			"code",
			"S",
			state({ choice: { model: "gpt-6.1-sol", effort: "high" } }),
		);

		expect(result.ranked.map((r) => `${r.offer.model}:${r.offer.effort}`)).toEqual([
			"gpt-6.1-sol:high",
		]);
	});

	it("never picks a banned effort level", () => {
		const result = pick(catalog, "code", "S", state({ bannedEfforts: ["xhigh", "max", "ultra"] }));

		expect(result.ranked.map((r) => r.offer.effort)).not.toContain("xhigh");

		expect(
			result.excluded.some((r) =>
				r.reasons.some((reason) => reason.startsWith("effort xhigh not allowed")),
			),
		).toBe(true);
	});

	it("ranks open offers in the tier band and names model, effort, plan and pool", () => {
		const result = pick(catalog, "code", "S", state());

		expect(models(result)).toEqual(["gemini-4-neon", "gpt-6-astra", "gpt-6.1-sol"]);

		expect(result.ranked[0]?.offer).toMatchObject({
			model: "gemini-4-neon",
			effort: "low",
			pool: { id: "google-ai:gemini", plan: "google-ai" },
		});

		expect(
			result.ranked.filter((r) => r.offer.model === "gemini-4-neon").map((r) => r.offer.effort),
		).toEqual(["low", "medium", "high", "xhigh"]);

		expect(
			result.ranked.filter((r) => r.offer.model === "gpt-6-astra").map((r) => r.offer.effort),
		).toEqual(["none", "low", "medium", "high", "xhigh"]);

		expect(
			result.ranked
				.filter((r) => r.offer.model === "gemini-4-neon")
				.every((r) => r.offer.score === 61),
		).toBe(true);
	});

	it("cools the whole pool when one model in it hit its limit", () => {
		const exhausted = { "gemini-4-neon-xhigh": NOW / 1000 + 3600 };
		const result = pick(catalog, "code", "B", state({ exhausted }));

		// gemini-4-neon-low is not in exhausted.json, but it shares the pool.
		expect(why(result, "gemini-4-neon-low")).toContain("pool cooling down");
		expect(result.tier).toBe("A");
		expect(ids(result)).not.toContain("gemini-4-neon-low");
	});

	it("drops a pool whose window is under the floor, and one whose quota cannot be read", () => {
		const low = pick(catalog, "code", "S", state({ reports: { "google-ai": google(90), codex } }));

		expect(why(low, "gemini-4-neon-xhigh")).toContain("google-ai:gemini-models:5h 10% left");
		expect(models(low)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);

		const unread = pick(catalog, "code", "S", state({ reports: { codex } }));

		expect(why(unread, "gemini-4-neon-xhigh")).toContain("no quota reading for google-ai");

		const signedOut: ServiceReport = {
			service: "codex",
			status: "signed-out",
			summary: "signed out",
			limits: [],
		};
		const out = pick(
			catalog,
			"code",
			"S",
			state({ reports: { "google-ai": google(10), codex: signedOut } }),
		);

		expect(models(out)).toEqual(["gemini-4-neon"]);

		const renamed: ServiceReport = {
			...google(10),
			limits: [{ id: "google-ai:gemini-ultra-models:5h", label: "", usedPct: 0 }],
		};
		const moved = pick(catalog, "code", "S", state({ reports: { "google-ai": renamed, codex } }));

		expect(why(moved, "gemini-4-neon-xhigh")).toContain("no google-ai window matches this pool");
	});

	it("honors the pools.json deny list by provider, model id and pattern", () => {
		for (const over of [
			{ deny: ["gemini"] },
			{ deny: ["gemini-4-neon"] },
			{ denyPatterns: ["neon"] },
		]) {
			const result = pick(catalog, "code", "S", state(over));

			expect(why(result, "gemini-4-neon-xhigh")).toContain("denied in pools.json");
			expect(models(result)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
		}

		const variant = pick(catalog, "code", "S", state({ deny: ["gemini-4-neon-xhigh"] }));

		expect(why(variant, "gemini-4-neon-xhigh")).toContain("denied in pools.json");
		expect(ids(variant)).toContain("gemini-4-neon-low");
	});

	it("keeps the Claude plan out and blocks Fable by family and by pool until the weekly reset", () => {
		const before = pick(catalog, "code", "S", state());

		expect(why(before, "opus")).toContain("explicit-use only");

		const fable = before.excluded.filter((row) => row.offer.model === "fable");

		expect(fable.map((row) => row.offer.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);

		for (const row of fable) {
			expect(row.reasons.join("; ")).toContain("Fable family blocked");
			expect(row.reasons.join("; ")).toContain("Fable pool blocked");
		}

		const after = pick(catalog, "code", "S", state({ nowMs: Date.parse("2026-11-24T10:00:01Z") }));

		expect(why(after, "fable")).not.toContain("Fable");
		expect(why(after, "fable")).toContain("explicit-use only");
	});

	it.each(["fable-max", "claude-fable-5-2-max"])(
		"preserves effort-scoped deny and invalid markers for legacy alias %s",
		(id) => {
			const current = state({
				blocks: [],
				pools: POOLS.map(({ service: _service, explicitOnly: _explicit, ...pool }) => pool),
				reports: {},
			});

			for (const marker of [
				{ deny: [id] },
				{
					availability: {
						cooldowns: {},
						signedOut: {},
						badOffers: { [`claude:${id}`]: NOW + 3600000 },
					},
				},
			]) {
				const result = pick(catalog, "code", "S", { ...current, ...marker });

				expect(
					result.ranked.filter((row) => row.offer.model === "fable").map((row) => row.offer.effort),
				).toEqual(["low", "medium", "high", "xhigh"]);

				expect(
					result.excluded.find((row) => row.offer.model === "fable" && row.offer.effort === "max")
						?.reasons,
				).toContain("deny" in marker ? "denied in pools.json" : "offer invalid for 24h");
			}
		},
	);

	it.each(["fable-max", "claude-fable-5-2"])(
		"preserves whole-pool cooldowns from legacy alias %s after grouping",
		(id) => {
			const result = pick(
				catalog,
				"code",
				"S",
				state({
					blocks: [],
					pools: POOLS.map(({ service: _service, explicitOnly: _explicit, ...pool }) => pool),
					reports: {},
					exhausted: { [id]: NOW / 1000 + 3600 },
				}),
			);
			const fable = result.excluded.filter((row) => row.offer.model === "fable");

			expect(fable).toHaveLength(5);

			expect(
				fable.every((row) => row.reasons.some((reason) => reason.startsWith("pool cooling down"))),
			).toBe(true);

			expect(models(result)).not.toContain("fable");
		},
	);

	it("keeps model-wide denies when a discarded catalog alias names the model", () => {
		const result = pick(
			catalog,
			"code",
			"S",
			state({
				blocks: [],
				pools: POOLS.map(({ service: _service, explicitOnly: _explicit, ...pool }) => pool),
				reports: {},
				deny: ["claude-fable-5-2"],
			}),
		);

		expect(models(result)).not.toContain("fable");

		expect(
			result.excluded
				.filter((row) => row.offer.model === "fable")
				.every((row) => row.reasons.includes("denied in pools.json")),
		).toBe(true);
	});

	it("never sends a sensitive brief to a China-hosted endpoint or a host that trains on our data", () => {
		const cnHost: Pool = {
			id: "test:cn",
			plan: "cn-api",
			windows: [],
			host: { name: "CN cloud", country: "cn" },
			trainsOnData: "no",
		};
		const usHost: Pool = {
			id: "test:us",
			plan: "us-api",
			windows: [],
			host: { name: "US cloud", country: "us" },
			trainsOnData: "no",
		};
		const cnOrigin: Catalog = {
			tiers: TIERS,
			models: [
				{ id: "qwen-coder-on-cn-host", provider: "api", pool: "test:cn", score: 60 },
				{ id: "qwen-coder-on-us-host", provider: "api", pool: "test:us", score: 59 },
				{ id: "gemini-4-neon-xhigh", provider: "gemini", score: 61 },
			],
		};
		const pools = [...POOLS, cnHost, usHost];

		const pub = pick(cnOrigin, "code", "S", state({ pools }));

		expect(models(pub)).toEqual([
			"gemini-4-neon",
			"qwen-coder-on-cn-host",
			"qwen-coder-on-us-host",
		]);

		const sens = pick(cnOrigin, "code", "S", state({ pools, dataClass: "sensitive" }));

		// A Chinese-origin model hosted outside China is fine; the China host and the training host are not.
		expect(ids(sens)).toEqual(["qwen-coder-on-us-host"]);
		expect(why(sens, "qwen-coder-on-cn-host")).toContain("is in China");
		expect(why(sens, "gemini-4-neon-xhigh")).toContain("trains on our data");
	});

	it("steps to the next tier only when the asked one is empty", () => {
		const exhausted = { "gpt-6-astra": NOW / 1000 + 60 };
		const result = pick(catalog, "code", "S", state({ exhausted, deny: ["gemini-4-neon"] }));

		expect(why(result, "gemini-4-neon-xhigh")).toContain("denied in pools.json");
		expect(result.tier).toBe("A");
		expect(models(result)).toEqual(["claude-sonnet-5-5"]);
	});
});

describe("brief", () => {
	it("rejects missing, empty and whitespace-only briefs", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "route-"));

		writeFileSync(path.join(dir, "empty"), "");
		writeFileSync(path.join(dir, "ws"), " \n\t\n");
		expect(readBrief(undefined)).toHaveProperty("error");
		expect(readBrief(path.join(dir, "nope"))).toHaveProperty("error");
		expect(readBrief(path.join(dir, "empty"))).toHaveProperty("error");
		expect(readBrief(path.join(dir, "ws"))).toHaveProperty("error");
	});

	it("raises a brief holding a credential to sensitive, never lowers it", () => {
		expect(effectiveDataClass("public", `token ghp_${"a".repeat(36)}`)).toBe("sensitive");
		expect(effectiveDataClass("public", "fix the flaky test")).toBe("public");
		expect(effectiveDataClass("sensitive", "fix the flaky test")).toBe("sensitive");
	});

	it("aborts on an empty brief before any quota reader runs", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "route-"));
		const marker = path.join(dir, "reader-ran");
		const reader = path.join(dir, "reader");

		writeFileSync(reader, `#!/bin/sh\ntouch ${marker}\n`);
		chmodSync(reader, 0o755);
		mkdirSync(path.join(dir, ".claude/shared"), { recursive: true });
		writeFileSync(path.join(dir, ".claude/shared/model-tiers.json"), JSON.stringify(catalog));
		writeFileSync(path.join(dir, "empty"), "\n");
		writeFileSync(path.join(dir, "brief"), "fix the flaky test\n");

		const route = (...args: string[]) =>
			spawnSync(process.execPath, [fileURLToPath(new URL("route.ts", import.meta.url)), ...args], {
				encoding: "utf8",
				env: {
					...process.env,
					HOME: dir,
					QUOTA_AGY_CMD: reader,
					QUOTA_CODEX_CMD: reader,
					QUOTA_CLAUDE_USAGE_CMD: reader,
				},
			});

		const empty = route("run", "gpt-6-astra:none", path.join(dir, "empty"));

		expect(empty.status).toBe(2);
		expect(empty.stderr).toContain("is empty");
		expect(existsSync(marker)).toBe(false);

		// Control: listing does reach the readers.
		// The fake readers leave Google unparsable and Codex signed in with no snapshot.
		const control = route("ls");

		expect(existsSync(marker)).toBe(true);
		expect(control.status).toBe(0);
		expect(control.stdout).toContain("runnable for code");
		expect(control.stdout).toMatch(/gpt-6-astra:none\s+codex/u);

		const explanation = route("why", "gemini-4-neon:xhigh");

		expect(explanation.stdout).toMatch(
			/gemini-4-neon:xhigh \[.*\] blocked: .*google-ai quota error/u,
		);

		const parcs = route("why", "gpt-6-astra", "--class", "parcs");

		expect(parcs.stdout).toContain("parcs brief: claude plan only");
	});
});

import { test as vtest, expect as vexpect } from "vitest";

import { vendorOf } from "./pick.ts";

vtest("vendorOf names the model maker, not the plan", () => {
	vexpect(vendorOf("gpt-6-astra")).toBe("openai");
	vexpect(vendorOf("gemini-4-neon")).toBe("google");
	vexpect(vendorOf("claude-opus-5-5")).toBe("anthropic");
	vexpect(vendorOf("fable")).toBe("anthropic");
	vexpect(vendorOf("qwen3:8b")).toBe("other");
});
