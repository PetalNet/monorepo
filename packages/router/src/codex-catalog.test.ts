import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { launch } from "./adapters.ts";
import {
	checkCodexAlerts,
	codexVersion,
	alertDefaults,
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
	vi.unstubAllEnvs();
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
	pools: POOLS.map(({ service: _service, ...pool }) => pool),
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
		let now = 1000;
		let offline = false;
		const deps = {
			now: () => now,
			command: (args: string[]) => {
				if (args[0] === "--version") {
					return `codex-cli ${version}`;
				}

				fetches++;

				if (offline) {
					throw new Error("offline");
				}

				return JSON.stringify({ ...raw, model_messages: "do not persist me" });
			},
		};

		expect(await discoverCodex(dir, false, deps)).toEqual(snapshot);
		await discoverCodex(dir, false, deps);
		expect(fetches).toBe(1);
		expect(await readFile(path.join(dir, "codex-models.json"), "utf8")).not.toContain("persist me");
		offline = true;
		now += 3_600_000;
		await expect(discoverCodex(dir, true, deps)).rejects.toThrow("refresh failed");
		expect(await discoverCodex(dir, false, deps)).toEqual(snapshot);
		version = "0.170.0";
		expect(await discoverCodex(dir, false, deps)).toBeUndefined();
	});

	it("rejects malformed catalogs without replacing the last valid cache", async () => {
		expect(() => parseModels({ models: [model("bad shell slug")] })).toThrow();
		expect(parseModels({ models: [model("hidden", "hide")] })).toEqual([]);
		const dir = await temp();

		await discoverCodex(dir, false, {
			now: () => 1000,
			command: (args) => (args[0] === "--version" ? "codex-cli 0.171.0" : JSON.stringify(raw)),
		});

		await expect(
			discoverCodex(dir, true, {
				now: () => 2000,
				command: (args) => (args[0] === "--version" ? "codex-cli 0.171.0" : "{}"),
			}),
		).rejects.toThrow("refresh failed");

		expect(JSON.parse(await readFile(path.join(dir, "codex-models.json"), "utf8"))).toEqual(
			snapshot,
		);
	});

	it("replaces visible models with an authoritative empty catalog on refresh and cache readback", async () => {
		const dir = await temp();
		let now = 1000;
		let visibility = "list";
		let queries = 0;
		const deps = {
			now: () => now,
			command: (args: string[]) => {
				if (args[0] === "--version") {
					return "codex-cli 0.171.0";
				}

				queries++;

				return JSON.stringify({ models: [model("gpt-7-sol", visibility)] });
			},
		};

		await discoverCodex(dir, false, deps);
		now += 3_600_000;
		visibility = "hide";
		const empty = await discoverCodex(dir, false, deps);

		expect(empty?.models).toEqual([]);
		expect(withCodexCatalog(catalog, empty).models.every((m) => m.provider !== "codex")).toBe(true);
		expect((await discoverCodex(dir, false, deps))?.models).toEqual([]);
		expect(queries).toBe(2);
	});

	it("passes a discovered max-suffixed release verbatim to a real fake executable", async () => {
		const dir = await temp();

		await writeFile(path.join(dir, "codex"), '#!/bin/sh\nprintf "%s\n" "$@"\ncat\n', {
			mode: 0o700,
		});

		vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);

		const discovered = {
			...snapshot,
			models: parseModels({
				models: [model("gpt-5.1-codex-max"), model("gpt-5.1-codex"), model("gpt-5.1-codex-high")],
			}),
		};
		const offers = offersFrom(withCodexCatalog(catalog, discovered), "code", POOLS);

		expect(new Set(offers.filter((o) => o.provider === "codex").map((o) => o.model))).toEqual(
			new Set(["gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1-codex-high"]),
		);

		const offer = offers.find((o) => o.model === "gpt-5.1-codex-max" && o.effort === "low");

		if (!offer) {
			throw new Error("missing discovered offer");
		}

		expect((await launch(offer, "brief", dir)).out).toContain("-m\ngpt-5.1-codex-max\n");

		const denied = pick(withCodexCatalog(catalog, discovered), "code", "*", {
			...state,
			deny: ["gpt-5.1-codex-max"],
		});

		expect(denied.ranked.some((r) => r.offer.model === "gpt-5.1-codex-max")).toBe(false);
		expect(denied.ranked.some((r) => r.offer.model === "gpt-5.1-codex")).toBe(true);

		const highDenied = pick(withCodexCatalog(catalog, discovered), "code", "*", {
			...state,
			deny: ["gpt-5.1-codex-high"],
		});

		expect(highDenied.ranked.some((r) => r.offer.model === "gpt-5.1-codex-high")).toBe(false);

		expect(
			highDenied.ranked.filter((r) => r.offer.model === "gpt-5.1-codex").map((r) => r.offer.effort),
		).toEqual(["low", "medium", "high"]);
	});

	it("retains exact multi-part benchmark release names and preview identities", () => {
		const result = normalizeAA({
			fetchedAt: "2026-11-22T00:00:00Z",
			models: ["gpt-7-1-codex-mini", "gpt-7-1-codex-mini-preview"].map((slug) => ({
				slug,
				release: { slug },
				effort: { slug: "high" },
				terminalBench40: 70,
			})),
		});

		expect(result.unmapped).toEqual([]);

		expect(new Set(result.rows.map((row) => row.model))).toEqual(
			new Set(["gpt-7.1-codex-mini", "gpt-7.1-codex-mini-preview"]),
		);
	});

	it.each([
		{ models: [{ slug: "gpt-7-sol" }] },
		{ models: [{ ...model("gpt-7-sol"), supported_reasoning_levels: [{}] }] },
	])("rejects malformed model metadata and preserves the prior cache", async (invalid) => {
		const dir = await temp();

		await discoverCodex(dir, false, {
			now: () => 1000,
			command: (args) => (args[0] === "--version" ? "codex-cli 0.171.0" : JSON.stringify(raw)),
		});

		await expect(
			discoverCodex(dir, true, {
				now: () => 2000,
				command: (args) =>
					args[0] === "--version" ? "codex-cli 0.171.0" : JSON.stringify(invalid),
			}),
		).rejects.toThrow("refresh failed");

		expect(JSON.parse(await readFile(path.join(dir, "codex-models.json"), "utf8"))).toEqual(
			snapshot,
		);
	});
});

describe("Codex alerts", () => {
	it("posts new models and releases older than three days once even with concurrent checks", async () => {
		const dir = await temp();
		const sent: string[] = [];
		const deps = {
			now: () => 10 * 86_400_000,
			release: () => ({ version: "0.172.0", publishedAt: 0 }),
			notify: (m: string) => {
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
			release: () => ({ version: "0.171.0", publishedAt: 0 }),
			notify: () => {
				throw new Error("delivery failed");
			},
		};

		await expect(checkCodexAlerts(dir, snapshot, catalog, deps)).rejects.toThrow("delivery failed");
		const sent: string[] = [];

		await checkCodexAlerts(dir, snapshot, catalog, {
			...deps,
			notify: (m) => {
				sent.push(m);
			},
		});

		expect(sent).toHaveLength(2);

		await checkCodexAlerts(dir, snapshot, withCodexCatalog(catalog, snapshot), {
			...deps,
			notify: () => {
				throw new Error("must be silent");
			},
		});
	});

	it("reports a failed release check after delivering independent new-model alerts", async () => {
		const dir = await temp();
		const sent: string[] = [];

		await expect(
			checkCodexAlerts(dir, snapshot, catalog, {
				now: () => 1000,
				release: () => {
					throw new Error("offline");
				},
				notify: (message) => {
					sent.push(message);
				},
			}),
		).rejects.toThrow("release check failed");

		expect(sent).toHaveLength(2);
	});

	it("retries durable pending events even when catalog and discovered models change", async () => {
		const dir = await temp();
		const deps = {
			now: () => 1000,
			release: () => ({ version: "0.171.0", publishedAt: 0 }),
			notify: () => {
				throw new Error("offline");
			},
		};

		await expect(checkCodexAlerts(dir, snapshot, catalog, deps)).rejects.toThrow("delivery failed");
		const sent: string[] = [];

		await checkCodexAlerts(dir, { ...snapshot, models: [] }, withCodexCatalog(catalog, snapshot), {
			...deps,
			notify: (message) => {
				sent.push(message);
			},
		});

		expect(sent).toHaveLength(2);
	});

	it("uses a stable remote event ID and shell-quotes the actual enqueue receiver", async () => {
		const dir = await temp();

		await writeFile(
			path.join(dir, "ssh"),
			'#!/usr/bin/env python3\nimport os,sys\nos.execvp("sh", ["sh", "-c", " ".join(sys.argv[6:])])\n',
			{ mode: 0o700 },
		);

		vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
		vi.stubEnv("HOME", dir);
		const message = "A 'quoted' model with $HOME and $(exit 23)";

		await alertDefaults.notify(message, "model:quoted");
		await alertDefaults.notify(message, "model:quoted");
		const { readdir } = await import("node:fs/promises");
		const outbox = path.join(dir, ".claude/shared/system-outbox");
		const files = (await readdir(outbox)).filter((name) => name.endsWith(".json"));

		expect(files).toHaveLength(1);

		expect(JSON.parse(await readFile(path.join(outbox, files[0] ?? ""), "utf8"))).toMatchObject({
			key: "model:quoted",
			body: `[info] codex-current: ${message}`,
		});
	});

	it("continues delivering independent keys when the first enqueue permanently fails", async () => {
		const dir = await temp();
		const delivered: string[] = [];
		const deps = {
			now: () => 1000,
			release: () => ({ version: "0.171.0", publishedAt: 0 }),
			notify: (_message: string, key: string) => {
				if (key === "model:gpt-6.2-sol") {
					throw new Error("failed queue");
				}

				delivered.push(key);
			},
		};

		await expect(checkCodexAlerts(dir, snapshot, catalog, deps)).rejects.toThrow("delivery failed");
		expect(delivered).toEqual(["model:gpt-6.2-astra"]);
		await expect(checkCodexAlerts(dir, snapshot, catalog, deps)).rejects.toThrow("delivery failed");
		expect(delivered).toEqual(["model:gpt-6.2-astra"]);
	});

	it("alerts on a stale installed client even when its model query fails", async () => {
		const dir = await temp();
		const command = (args: string[]) => {
			if (args[0] === "--version") {
				return "codex-cli 0.164.0";
			}

			throw new Error("models unavailable");
		};

		await expect(discoverCodex(dir, true, { now: () => 1000, command })).rejects.toThrow(
			"refresh failed",
		);

		const sent: string[] = [];

		await checkCodexAlerts(dir, undefined, catalog, {
			now: () => 10 * 86_400_000,
			clientVersion: () => codexVersion(command),
			release: () => ({ version: "0.171.0", publishedAt: 0 }),
			notify: (message) => {
				sent.push(message);
			},
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("Codex 0.164.0 lags 0.171.0");
	});
});
