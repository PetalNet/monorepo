import { describe, expect, it } from "vitest";

import { normalizeAA, resolveSignal, scoreEvidence, type EvidenceRow } from "./evidence.ts";
import { POOLS, pick, type State } from "./pick.ts";
import { effectiveDataClass, formatPick } from "./route.ts";
const now = Date.parse("2026-11-19T00:00:00Z");
const row = (model: string, effort: string, signal: string, value: number): EvidenceRow => ({
	model,
	effort,
	signal,
	value,
	src: "AA",
	kind: "measured",
	asof: new Date(now).toISOString(),
	url: "https://example.com/synthetic",
});
const state: State = {
	nowMs: now,
	dataClass: "public",
	reports: {},
	exhausted: {},
	deny: [],
	denyPatterns: [],
	pools: POOLS.map((p) => ({ ...p, service: undefined })).map(({ service: _service, ...p }) => p),
	blocks: [],
	floorPct: 15,
};

describe("evidence", () => {
	it("normalizes nested zeroes, explicit aliases and efforts; lists unknown releases", () => {
		const result = normalizeAA({
			fetchedAt: new Date(now).toISOString(),
			models: [
				{
					slug: "gpt-6-1-sol-low",
					release: { slug: "gpt-6-1-sol" },
					effort: { slug: "low" },
					headline: { outputSpeed: 0 },
					intelligenceIndex: null,
				},
				{ slug: "unknown", release: { slug: "unknown" }, effort: { slug: "high" } },
			],
		});

		expect(result.rows).toEqual([
			{
				...row("gpt-6.1-sol", "low", "headline.outputSpeed", 0),
				url: "https://artificialanalysis.ai/models/gpt-6-1-sol-low",
			},
		]);

		expect(result.unmapped).toEqual(["unknown"]);
		expect(() => normalizeAA({})).toThrow();
	});

	it("computes confidence-weighted Q, observed coverage and headroom utility", () => {
		const evidence = {
			rows: [
				row("gpt-test", "high", "terminalBench40", 1),
				row("gpt-test", "high", "frontierCode20", 1),
			],
			unmapped: [],
			notes: [],
		};
		const result = scoreEvidence(evidence, "gpt-test", "high", "code", now, 100);

		expect(result.coverage).toBeCloseTo(0.8);
		expect(result.q).toBeCloseTo(0.5);
		expect(result.p).toBeCloseTo(0.685);
		expect(result.lambda).toBe(0.5);

		expect(result.utility).toBeCloseTo(
			10 * 0.685 - 0.5 * 0.01 * 1 - (0.05 * (2 + 12000 / 50)) / 60,
		);

		expect(scoreEvidence(evidence, "gpt-test", "high", "code", now, 20).utility).toBeLessThan(
			result.utility,
		);

		expect(result.missing).toEqual(["intelligenceIndex", "arena_webdev"]);
	});

	it("uses exact measurements before vendors, interpolation, family median and dropping", () => {
		const lo = row("gpt-test", "low", "terminalBench40", 0.2);
		const hi = row("gpt-test", "high", "terminalBench40", 0.6);

		expect(resolveSignal([lo, hi], "gpt-test", "medium", "terminalBench40")).toMatchObject({
			value: 0.4,
			kind: "interpolated",
		});

		expect(resolveSignal([lo, hi], "gpt-other", "max", "terminalBench40")).toMatchObject({
			value: 0.4,
			kind: "family-prior",
		});

		expect(resolveSignal([lo, hi], "claude-other", "max", "terminalBench40")).toBeUndefined();

		expect(
			resolveSignal(
				[{ ...hi, kind: "vendor", value: 1 }, hi],
				"gpt-test",
				"high",
				"terminalBench40",
			)?.value,
		).toBe(0.6);

		const evidence = { rows: [lo, hi], unmapped: [], notes: [] };

		expect(scoreEvidence(evidence, "gpt-other", "max", "code", now, 100).coverage).toBe(0);
	});

	it("uses evidence at the coverage boundary and labels sparse table fallback", () => {
		const catalog = {
			tiers: { S: 57 },
			models: [{ id: "gpt-6-astra", provider: "codex", score: 61 }],
		};
		const rows = ["code2videoElo", "frontierCode20", "mmmuPro"].map((s) =>
			row("gpt-6-astra", "medium", s, 1),
		);
		const full = pick(catalog, "ui", "S", { ...state, evidence: { rows, unmapped: [], notes: [] } })
			.ranked[0];

		expect(full).toMatchObject({ source: "evidence", offer: { effort: "medium" } });

		const sparse = pick(catalog, "ui", "S", {
			...state,
			evidence: { rows: rows.slice(1), unmapped: [], notes: [] },
		}).ranked[0];

		expect(sparse).toMatchObject({ source: "table" });
	});
});

describe("Parker policy", () => {
	it("records opt-outs only on the OpenAI and Anthropic account pools", () => {
		for (const p of POOLS.filter((pool) => ["codex", "claude"].includes(pool.plan))) {
			expect(p).toMatchObject({ trainsOnData: "no", trainingSource: "Parker 2026-11-19" });
		}

		expect(POOLS.filter((p) => p.plan === "google-ai").every((p) => p.trainsOnData === "yes")).toBe(
			true,
		);
	});

	it("permits sensitive Codex and restricts parcs to the explicit Claude plan", () => {
		const catalog = {
			tiers: { S: 57 },
			models: [
				{ id: "gpt-6-astra", provider: "codex", score: 61 },
				{ id: "opus", provider: "claude", score: 59 },
				{ id: "claude-opus-5-5-high", provider: "agy-claude", score: 59 },
			],
		};

		expect([
			...new Set(
				pick(catalog, "code", "S", { ...state, dataClass: "sensitive" }).ranked.map(
					(r) => r.offer.id,
				),
			),
		]).toEqual(["gpt-6-astra"]);

		expect([
			...new Set(
				pick(catalog, "code", "S", { ...state, dataClass: "parcs" }).ranked.map((r) => r.offer.id),
			),
		]).toEqual(["opus"]);

		expect(effectiveDataClass("public", "Prepare Bridgeton brief")).toBe("parcs");
		expect(effectiveDataClass("parcs", `sk-${"x".repeat(30)}`)).toBe("parcs");
	});
});

it("overrides a higher hand score with measured code evidence", () => {
	const catalog = {
		tiers: { S: 57 },
		models: [
			{ id: "gpt-6-astra", provider: "codex", score: 65 },
			{ id: "gemini-4-neon-high", provider: "gemini", score: 59 },
		],
	};
	const rows = ["terminalBench40", "frontierCode20", "intelligenceIndex"].flatMap((signal) => [
		row("gpt-6-astra", "medium", signal, 0.2),
		row("gemini-4-neon", "high", signal, 0.9),
	]);

	expect(pick(catalog, "code", "S", state).ranked[0]?.offer.id).toBe("gpt-6-astra");

	expect(
		pick(catalog, "code", "S", { ...state, evidence: { rows, unmapped: [], notes: [] } }).ranked[0],
	).toMatchObject({ offer: { id: "gemini-4-neon-high" }, source: "evidence" });
});

it("decays old measured evidence toward the family prior and inverts hallucination", () => {
	const rows = [
		row("gpt-test", "high", "terminalBench40", 1),
		row("gpt-peer", "high", "terminalBench40", 0),
	];
	const fresh = scoreEvidence(
		{ rows, unmapped: [], notes: [] },
		"gpt-test",
		"high",
		"code",
		now,
		100,
	);
	const aged = scoreEvidence(
		{ rows, unmapped: [], notes: [] },
		"gpt-test",
		"high",
		"code",
		now + 180 * 86400000,
		100,
	);

	expect(fresh.q).toBeCloseTo((0.4 * 0.75 + 0.15 * 0.5) / (0.4 + 0.15));
	expect(aged.q).toBeCloseTo((0.2 * 0.75 + 0.15 * 0.5) / (0.2 + 0.15));

	const hallucinations = [
		row("gpt-test", "high", "omniscienceHallucinationRate", 0),
		row("gpt-peer", "high", "omniscienceHallucinationRate", 1),
	];
	const evidence = { rows: hallucinations, unmapped: [], notes: [] };

	expect(scoreEvidence(evidence, "gpt-test", "high", "research", now, 100).q).toBeGreaterThan(
		scoreEvidence(evidence, "gpt-peer", "high", "research", now, 100).q,
	);
});

it("scores each effort's cost, tokens, speed and TTFT, interpolating only missing inputs", () => {
	const metrics = [
		["intelligenceIndexCostPerTask.cost.total", 1, 3],
		["intelligenceIndexOutputTokensPerTask.output", 6000, 18000],
		["headline.outputSpeed", 40, 80],
		["headline.timeToFirstToken", 2, 10],
	] as const;
	const rows = metrics.flatMap(([signal, low, high]) => [
		row("gpt-test", "low", signal, low),
		row("gpt-test", "high", signal, high),
	]);

	rows.push(row("gpt-test", "medium", "headline.timeToFirstToken", 3));
	const evidence = { rows, notes: [], unmapped: [] };
	const low = scoreEvidence(evidence, "gpt-test", "low", "code", now, 100);
	const medium = scoreEvidence(evidence, "gpt-test", "medium", "code", now, 100);
	const high = scoreEvidence(evidence, "gpt-test", "high", "code", now, 100);

	expect(low).toMatchObject({ cost: 1, tokens: 6000, speed: 40, ttft: 2, seconds: 152 });
	expect(medium).toMatchObject({ cost: 2, tokens: 12000, speed: 60, ttft: 3, seconds: 203 });
	expect(high).toMatchObject({ cost: 3, tokens: 18000, speed: 80, ttft: 10, seconds: 235 });
	expect(medium.signals.filter((s) => s.kind === "interpolated")).toHaveLength(3);

	expect(medium.signals.find((s) => s.signal === "headline.timeToFirstToken")?.kind).toBe(
		"measured",
	);

	expect(resolveSignal(rows, "gpt-test", "xhigh", metrics[0][0])).toMatchObject({
		value: 3,
		kind: "interpolated",
		src: "AA interpolation clamped to high (outside measured curve)",
	});
});

it("keeps interpolated quality between equally fresh measured endpoints despite a stronger family prior", () => {
	const rows = [
		row("gpt-test", "low", "aa_cyber_index", 0),
		row("gpt-test", "high", "aa_cyber_index", 0.1),
		...Array.from({ length: 10 }, (_, i) =>
			row(`gpt-peer-${String(i)}`, "high", "aa_cyber_index", i + 1),
		),
	];
	const input = { rows, notes: [], unmapped: [] };
	const quality = (effort: string) => scoreEvidence(input, "gpt-test", effort, "cyber", now, 100).q;

	expect(quality("medium")).toBeGreaterThanOrEqual(quality("low"));
	expect(quality("medium")).toBeLessThanOrEqual(quality("high"));
});

it("chooses low for a routine sweep and xhigh for code from the same effort curve", () => {
	const rows = ["low", "medium", "high", "xhigh"].flatMap((effort, i) => [
		row("gpt-test", effort, "automationBenchPartialScore", 0.9),
		row("gpt-test", effort, "tau2", 0.9),
		row("gpt-test", effort, "terminalBench40", 0.4 + i * 0.15),
		row("gpt-test", effort, "frontierCode20", 0.4 + i * 0.15),
		row("gpt-test", effort, "intelligenceIndexCostPerTask.cost.total", 0.1 + i * 0.2),
		row("gpt-test", effort, "intelligenceIndexOutputTokensPerTask.output", 3000 + i * 6000),
		row("gpt-test", effort, "headline.outputSpeed", 60),
		row("gpt-test", effort, "headline.timeToFirstToken", 2 + i * 5),
	]);
	const input = { ...state, evidence: { rows, notes: [], unmapped: [] } };
	const catalog = { tiers: { S: 57 }, models: [{ id: "gpt-test", provider: "codex", score: 60 }] };
	const sweep = pick(catalog, "sweep", "S", input);
	const code = pick(catalog, "code", "S", input);

	expect(sweep.ranked[0]?.offer.effort).toBe("low");
	expect(code.ranked[0]?.offer.effort).toBe("xhigh");
	expect(sweep.ranked).toHaveLength(5);
	expect(formatPick(sweep, "sweep", "S")).toContain("vs medium: ΔQ=");

	expect(formatPick(code, "code", "S")).toMatch(
		/vs high: .*quality-value=.*task-cost=.*time=.*ΔU=/u,
	);
});

it("uses exact cyber evidence ahead of a higher table-only score and does not count its components twice", () => {
	const rows = [
		row("gpt-test", "high", "aa_cyber_index", 40),
		row("gpt-test", "high", "aa_cwe_bench", 0.5),
	];
	const result = pick(
		{
			tiers: { S: 57 },
			models: [
				{ id: "gpt-test", provider: "codex", score: 60 },
				{ id: "gpt-peer", provider: "codex", score: 99 },
			],
		},
		"cyber",
		"S",
		{ ...state, evidence: { rows, notes: [], unmapped: [] } },
	);

	expect(result.ranked[0]).toMatchObject({
		source: "evidence",
		offer: { model: "gpt-test", effort: "high" },
		evidence: { coverage: 0.7 },
	});

	expect(result.ranked[0]?.evidence?.crossChecks).toHaveLength(1);
	expect(result.ranked.find((r) => r.offer.model === "gpt-peer")?.evidence?.coverage).toBe(0);
});

it("normalizes AA non-reasoning records as none without assigning unspecified records an effort", () => {
	const result = normalizeAA({
		fetchedAt: new Date(now).toISOString(),
		models: [
			{
				slug: "gpt-6-luna-non-reasoning",
				release: { slug: "gpt-6-luna" },
				effort: null,
				intelligenceIndex: 10,
			},
			{
				slug: "gpt-6-luna-unknown",
				release: { slug: "gpt-6-luna" },
				effort: null,
				intelligenceIndex: 20,
			},
		],
	});

	expect(result.rows[0]).toMatchObject({ effort: "none", value: 10 });
	expect(result.unmapped).toEqual(["gpt-6-luna-unknown"]);
});
