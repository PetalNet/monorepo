import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { launch } from "./adapters.ts";
import {
	halfLifeDays,
	resolveSignal,
	scoreEvidence,
	type Evidence,
	type EvidenceRow,
} from "./evidence.ts";
import { normalizeOpenEvidence, readOpenEvidence } from "./open-evidence.ts";
import { pick, POOLS, type State } from "./pick.ts";

const now = Date.parse("2026-11-19T00:00:00Z");
const row = (signal: string, effort = "max", value = 1): EvidenceRow => ({
	model: "gpt-test",
	effort,
	signal,
	value,
	kind: "measured",
	src: "Arena",
	asof: new Date(now).toISOString(),
	url: "https://example.com/synthetic",
	reporter: "Arena",
	halfLifeDays: 90,
});
const evidence = (rows: EvidenceRow[]): Evidence => ({ rows, notes: [], unmapped: [] });
const state: State = {
	nowMs: now,
	dataClass: "public",
	reports: {},
	exhausted: {},
	deny: [],
	denyPatterns: [],
	pools: POOLS.map(({ service: _service, ...pool }) => pool),
	blocks: [],
	floorPct: 15,
};

it("loads provenance and model-level effort, rejecting malformed artifacts", () => {
	const input = evidence([row("arena_webdev", "unspecified", 0)]);

	expect(normalizeOpenEvidence(input)).toEqual(input);
	expect(normalizeOpenEvidence(evidence([row("epoch_gpqa", "none")])).rows[0]?.effort).toBe("none");

	for (const bad of [
		{ value: NaN },
		{ kind: "family-prior" },
		{ effort: "turbo" },
		{ asof: "never" },
		{ halfLifeDays: 0 },
		{ reporter: undefined },
		{ url: "file:///secret" },
	]) {
		expect(() =>
			normalizeOpenEvidence({
				rows: [{ ...row("arena_webdev"), ...bad }],
				notes: [],
				unmapped: [],
			}),
		).toThrow();
	}

	const dir = mkdtempSync(path.join(tmpdir(), "router-evidence-"));

	try {
		const file = path.join(dir, "open.json");

		expect(readOpenEvidence(file).rows).toEqual([]);
		writeFileSync(file, "broken");
		expect(() => readOpenEvidence(file)).toThrow();
		writeFileSync(file, JSON.stringify(input));
		expect(readOpenEvidence(file)).toEqual(input);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("keeps unspecified effort visible and labels a max-only curve as interpolation", () => {
	const modelLevel = row("eqbench_creative_v3", "unspecified");

	expect(resolveSignal([modelLevel], "gpt-test", "medium", modelLevel.signal)).toEqual(modelLevel);

	expect(resolveSignal([row("arena_webdev")], "gpt-test", "medium", "arena_webdev")?.kind).toBe(
		"interpolated",
	);

	expect(
		scoreEvidence(evidence([row("arena_webdev")]), "gpt-test", "medium", "ui", now, 100).coverage,
	).toBeCloseTo(0.35);

	const measured = row("eqbench_creative_v3", "medium", 2);

	expect(resolveSignal([modelLevel, measured], "gpt-test", "medium", measured.signal)).toEqual(
		measured,
	);
});

it("uses source half-lives for confidence and retains vendor discount", () => {
	const rows = [row("arena_webdev"), { ...row("arena_webdev", "max", 0), model: "gpt-peer" }];
	const fresh = scoreEvidence(evidence(rows), "gpt-test", "max", "ui", now, 100);
	const old = scoreEvidence(evidence(rows), "gpt-test", "max", "ui", now + 90 * 86400000, 100);

	expect(fresh.q).toBeCloseTo((0.35 * 0.75 + 0.15 * 0.5) / (0.35 + 0.15));
	expect(old.q).toBeCloseTo((0.175 * 0.75 + 0.15 * 0.5) / (0.175 + 0.15));
	const { halfLifeDays: _halfLife, ...withoutHalfLife } = row("x");

	expect(halfLifeDays({ ...withoutHalfLife, src: "Epoch" })).toBe(180);
	expect(halfLifeDays({ ...withoutHalfLife, kind: "vendor" })).toBe(365);
});

it("reports Epoch cross-checks without changing quality or coverage", () => {
	const base = evidence([row("frontierCode20")]);
	const extra = evidence([...base.rows, { ...row("epoch_mirrorcode"), src: "Epoch" }]);
	const before = scoreEvidence(base, "gpt-test", "max", "code", now, 100);
	const after = scoreEvidence(extra, "gpt-test", "max", "code", now, 100);

	expect(after.coverage).toBe(before.coverage);
	expect(after.q).toBe(before.q);
	expect(after.crossChecks).toEqual([extra.rows[1]]);
});

it("selects an observed effort with sufficient coverage and sends it to Codex", async () => {
	const catalog = { tiers: { S: 57 }, models: [{ id: "gpt-test", provider: "codex", score: 60 }] };
	const rows = [
		row("arena_webdev", "xhigh"),
		row("frontierCode20", "xhigh"),
		row("mmmuPro", "xhigh"),
	];
	const result = pick(catalog, "ui", "S", { ...state, evidence: evidence(rows) });
	const selected = result.ranked[0];

	expect(selected).toMatchObject({
		source: "evidence",
		offer: { id: "gpt-test", effort: "xhigh" },
	});

	expect(selected?.evidence?.coverage).toBeCloseTo(0.55);

	if (!selected) {
		throw new Error("no selected offer");
	}

	const dir = mkdtempSync(path.join(tmpdir(), "router-codex-"));

	try {
		writeFileSync(path.join(dir, "codex"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });
		vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
		const executed = await launch(selected.offer, "Synthetic test brief", dir);

		expect(executed.code).toBe(0);
		expect(executed.out).toContain("model_reasoning_effort=xhigh");
	} finally {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	}

	const blocked = pick(catalog, "ui", "S", {
		...state,
		evidence: evidence(rows),
		availability: { cooldowns: {}, signedOut: {}, badOffers: { "codex:gpt-test": now + 60000 } },
	});

	expect(blocked.ranked).toEqual([]);
	expect(blocked.excluded[0]?.reasons).toContain("offer invalid for 24h");
	const fixed = { ...catalog, models: [{ id: "gpt-test-medium", provider: "codex", score: 60 }] };

	expect(pick(fixed, "ui", "S", { ...state, evidence: evidence(rows) }).ranked[0]).toMatchObject({
		source: "evidence",
		offer: { effort: "xhigh" },
	});
});

it("fills missing levels from their own model curve and retains interpolation provenance", () => {
	const rows = [
		row("eqbench_creative_v3", "unspecified"),
		row("arena_text"),
		row("arena_creative"),
		row("briefcaseBreakdown.overall.elo", "medium", 100),
		row("gdpval", "medium", 100),
		row("headline.outputSpeed", "max", 1),
		row("headline.outputSpeed", "medium", 100),
	];
	const input = evidence(rows);
	const medium = scoreEvidence(input, "gpt-test", "medium", "write", now, 100);
	const max = scoreEvidence(input, "gpt-test", "max", "write", now, 100);

	expect(medium.coverage).toBeCloseTo(0.75);
	expect(max.coverage).toBeCloseTo(0.75);
	expect(medium.utility).toBeGreaterThan(max.utility);

	expect(medium.signals.find((s) => s.signal === "arena_text")).toMatchObject({
		kind: "interpolated",
		effort: "medium",
	});

	const catalog = { tiers: { S: 57 }, models: [{ id: "gpt-test", provider: "codex", score: 60 }] };

	expect(pick(catalog, "write", "S", { ...state, evidence: input }).ranked[0]?.offer.effort).toBe(
		"medium",
	);
});
