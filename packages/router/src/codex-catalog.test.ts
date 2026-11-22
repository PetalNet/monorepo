import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	checkCodexAlerts,
	discoverCodex,
	parseModels,
	withCodexCatalog,
	type Snapshot,
} from "./codex-catalog.ts";
import { normalizeAA } from "./evidence.ts";
import { offersFrom, pick, POOLS, type Catalog, type State } from "./pick.ts";
import { formatMenu } from "./route.ts";

const dirs: string[] = [];
async function temp() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "codex-catalog-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const model = (
	slug: string,
	visibility = "list",
	efforts = ["low", "medium", "high", "xhigh", "max", "ultra"],
) => ({ slug, visibility, supported_reasoning_levels: efforts.map((effort) => ({ effort })) });
const raw = {
	models: [
		model("gpt-6.2-sol"),
		model("gpt-6.2-astra"),
		model("gpt-6-astra"),
		model("gpt-reserve", "hide"),
		model("codex-auto-review", "hide"),
	],
};
const catalog: Catalog = {
	models: [
		{ id: "gpt-6.1-sol", provider: "codex", score: 58 },
		{ id: "gpt-6-astra", provider: "codex", score: 61 },
		{ id: "opus", provider: "claude", score: 59 },
	],
	tiers: { S: 57, A: 52, B: 46, C: 0 },
};
const snapshot: Snapshot = { client_version: "0.171.0", fetchedAt: 1000, models: parseModels(raw) };
const state: State = {
	nowMs: Date.now(),
	dataClass: "public",
	reports: {},
	pools: POOLS.map(({ service: _, ...pool }) => pool),
	exhausted: {},
	deny: [],
	denyPatterns: ["gpt-6-astra"],
	blocks: [],
	floorPct: 15,
	bannedEfforts: ["xhigh", "max", "ultra"],
};

describe("live Codex catalog", () => {
	it("adds future releases with conservative family priors and only advertised allowed efforts", () => {
		const next = withCodexCatalog(catalog, snapshot);
		expect(next.models.find((m) => m.id === "gpt-6.2-sol")).toMatchObject({
			score: 52.2,
			unproven: true,
		});
		expect(next.models.find((m) => m.id === "gpt-6.2-astra")).toMatchObject({
			score: 54.9,
			unproven: true,
		});
		expect(next.models.some((m) => m.id === "gpt-6.1-sol")).toBe(false);
		expect(
			offersFrom(next, "code", POOLS)
				.filter((m) => m.provider === "codex")
				.every((m) => ["low", "medium", "high"].includes(m.effort)),
		).toBe(true);
	});
	it.each(["code", "ui", "research"])(
		"makes 6.2 runnable for %s, preserves the old Astra deny and explicit Claude policy",
		(kind) => {
			const result = pick(withCodexCatalog(catalog, snapshot), kind, "*", state);
			expect(new Set(result.ranked.map((r) => r.offer.model))).toEqual(
				new Set(["gpt-6.2-sol", "gpt-6.2-astra"]),
			);
			expect(formatMenu(result, kind)).toContain("new, unproven");
			expect(
				result.excluded
					.filter((r) => r.offer.model === "gpt-6-astra")
					.every((r) => r.reasons.some((reason) => reason.includes("denied"))),
			).toBe(true);
		},
	);
	it("accepts later generations without a code edit and excludes internal slugs even if listed", () => {
		expect(
			parseModels({
				models: [
					model("gpt-7.1-astra"),
					model("gpt-reserve"),
					model("codex-auto-review"),
					model("hidden-next", "hide"),
				],
			}).map((m) => m.slug),
		).toEqual(["gpt-7.1-astra"]);
	});
	it("uses evidence for the exact new release when it arrives", () => {
		const evidence = normalizeAA({
			fetchedAt: "2026-11-22T00:00:00Z",
			models: [
				{
					slug: "gpt-6-2-astra-high",
					release: { slug: "gpt-6-2-astra" },
					effort: { slug: "high" },
					evaluations: { intelligenceIndex: 65 },
				},
			],
		});
		expect(evidence.unmapped).toEqual([]);
		expect(evidence.rows[0]?.model).toBe("gpt-6.2-astra");
	});
	it("caches only model metadata, refreshes for a changed client and retains same-client data offline", async () => {
		const dir = await temp();
		let version = "0.171.0";
		let fetches = 0;
		let offline = false;
		const deps = {
			now: () => 1000,
			command: async (args: string[]) => {
				if (args[0] === "--version") return `codex-cli ${version}`;
				fetches++;
				if (offline) throw new Error("offline");
				return JSON.stringify({ ...raw, model_messages: "do not persist me" });
			},
		};
		expect(await discoverCodex(dir, false, deps)).toEqual(snapshot);
		await discoverCodex(dir, false, deps);
		expect(fetches).toBe(1);
		expect(await readFile(path.join(dir, "codex-models.json"), "utf8")).not.toContain("persist me");
		offline = true;
		expect(await discoverCodex(dir, true, deps)).toEqual(snapshot);
		version = "0.170.0";
		expect(await discoverCodex(dir, false, deps)).toBeUndefined();
	});
	it("rejects malformed or empty catalogs without replacing the last valid cache", async () => {
		expect(() => parseModels({ models: [model("bad shell slug")] })).toThrow();
		expect(() => parseModels({ models: [model("hidden", "hide")] })).toThrow();
		const dir = await temp();
		await discoverCodex(dir, false, {
			now: () => 1000,
			command: async (args) =>
				args[0] === "--version" ? "codex-cli 0.171.0" : JSON.stringify(raw),
		});
		expect(
			await discoverCodex(dir, true, {
				now: () => 2000,
				command: async (args) => (args[0] === "--version" ? "codex-cli 0.171.0" : "{}"),
			}),
		).toEqual(snapshot);
	});
});

describe("Codex alerts", () => {
	it("posts new models and releases older than three days once even with concurrent checks", async () => {
		const dir = await temp();
		const sent: string[] = [];
		const deps = {
			now: () => 10 * 86_400_000,
			release: async () => ({ version: "0.172.0", publishedAt: 0 }),
			notify: async (m: string) => {
				sent.push(m);
			},
		};
		await Promise.all([
			checkCodexAlerts(dir, snapshot, catalog, deps),
			checkCodexAlerts(dir, snapshot, catalog, deps),
		]);
		expect(sent).toHaveLength(3);
		expect(sent.join("\n")).toContain("lags 0.172.0");
		await checkCodexAlerts(dir, snapshot, catalog, deps);
		expect(sent).toHaveLength(3);
	});
	it("is silent for current clients and retries delivery failures", async () => {
		const dir = await temp();
		const deps = {
			now: () => 1000,
			release: async () => ({ version: "0.171.0", publishedAt: 0 }),
			notify: async () => {
				throw new Error("delivery failed");
			},
		};
		await expect(checkCodexAlerts(dir, snapshot, catalog, deps)).rejects.toThrow("delivery failed");
		const sent: string[] = [];
		await checkCodexAlerts(dir, snapshot, catalog, {
			...deps,
			notify: async (m) => {
				sent.push(m);
			},
		});
		expect(sent).toHaveLength(2);
		await checkCodexAlerts(dir, snapshot, withCodexCatalog(catalog, snapshot), {
			...deps,
			notify: async () => {
				throw new Error("must be silent");
			},
		});
	});
});
