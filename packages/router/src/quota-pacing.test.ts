import { describe, expect, it } from "vitest";

import { readLedger } from "./quota-pacing-command.ts";
import {
	burnKey,
	estimateBurn,
	hostSlots,
	HOUR_MS,
	recommend,
	type Candidate,
	type Reading,
} from "./quota-pacing.ts";

const now = Date.UTC(2026, 10, 23, 20);
const weekly = "google-ai:gemini-models:7d";
const short = "google-ai:gemini-models:5h";
const argon = "google-ai:gemini-4-argon:7d";
const model = { pool: "google-ai:gemini", model: "gemini-4-neon", effort: "medium" };
const other = { pool: "google-ai:argon", model: "gemini-4-argon", effort: "high" };
const windowsByPool = new Map([
	[model.pool, [weekly, short]],
	[other.pool, [argon, short]],
]);
const poolProviders = new Map([
	[model.pool, "google-ai"],
	[other.pool, "google-ai"],
]);
const providerCaps = new Map([["google-ai", 2]]);
const burn = { perHour: 4, perRun: 2, hoursPerRun: 0.25, samples: 5 };
const burns = new Map([
	[burnKey(model, weekly), burn],
	[burnKey(model, short), burn],
	[burnKey(other, argon), burn],
	[burnKey(other, short), burn],
]);
const window = (id: string, usedPct: number, hoursRemaining: number) => ({
	id,
	usedPct,
	resetAt: now + hoursRemaining * HOUR_MS,
	duration: (id === short ? 5 : 168) * HOUR_MS,
});
const gemini: Candidate = {
	...model,
	provider: "google-ai",
	windows: [window(weekly, 80, 12), window(short, 50, 2)],
};
const argonBuilder: Candidate = {
	...other,
	provider: "google-ai",
	windows: [window(argon, 80, 12), window(short, 50, 2)],
};
const context = {
	now,
	slots: 2,
	candidates: [gemini],
	active: [],
	burns,
	providerCaps,
	poolProviders,
	windowsByPool,
};

describe("quota pacing", () => {
	it("only recommends work that fits the short and weekly budgets", () => {
		expect(recommend(context)).toEqual([gemini, gemini]);

		expect(
			recommend({
				...context,
				candidates: [{ ...gemini, windows: [window(weekly, 93, 72), window(short, 3, 4)] }],
			}),
		).toEqual([]);

		expect(
			recommend({
				...context,
				candidates: [{ ...gemini, windows: [window(weekly, 15, 12), window(short, 97, 0.2)] }],
			}),
		).toEqual([]);
	});

	it("reserves a full run for existing builders, including across a shared window", () => {
		const oneLeft = { ...gemini, windows: [window(weekly, 80, 12), window(short, 94, 0.2)] };

		expect(recommend({ ...context, candidates: [oneLeft] })).toEqual([oneLeft]);
		expect(recommend({ ...context, candidates: [oneLeft], active: [other] })).toEqual([]);
		expect(recommend({ ...context, active: [{ ...other, effort: "unknown" }] })).toEqual([]);
	});

	it("obeys effective host and plan capacity across competing pools", () => {
		expect(hostSlots(2_499, 20_000, 0)).toBe(0);
		expect(hostSlots(10_000, 7_999, 0)).toBe(0);
		expect(hostSlots(8_644, 8_000, 0)).toBe(2);
		expect(hostSlots(13_600, 8_000, 4)).toBe(0);
		expect(recommend({ ...context, slots: 4, candidates: [gemini, argonBuilder] })).toHaveLength(2);
		expect(recommend({ ...context, slots: 0 })).toEqual([]);
	});

	it("holds when rates or the current reset are unavailable", () => {
		expect(recommend({ ...context, burns: new Map() })).toEqual([]);

		expect(
			recommend({ ...context, candidates: [{ ...gemini, windows: [window(weekly, 16, -0.01)] }] }),
		).toEqual([]);
	});

	it("starts an idle short clock with one affordable builder", () => {
		const idle = { ...window(short, 0, 5), idle: true as const };
		const first = { ...gemini, windows: [window(weekly, 75, 12), idle] };
		const idleBurns = new Map(burns).set(burnKey(model, short), { ...burn, perRun: 19.5 });

		expect(recommend({ ...context, candidates: [first], burns: idleBurns })).toEqual([first]);

		expect(
			recommend({ ...context, candidates: [first], burns: idleBurns, active: [other] }),
		).toEqual([]);

		const skewed = { ...first, windows: [window(weekly, 0, 168), window(short, 0, 5.001)] };

		expect(recommend({ ...context, candidates: [skewed], burns: idleBurns })).toEqual([skewed]);
	});

	it("chooses the first affordable ranked model for a pool", () => {
		const cheaper = { ...gemini, model: "cheaper" };
		const bothRates = new Map(burns)
			.set(burnKey(cheaper, weekly), { ...burn, perRun: 1 })
			.set(burnKey(cheaper, short), { ...burn, perRun: 1 });

		expect(
			recommend({ ...context, slots: 1, candidates: [gemini, cheaper], burns: bothRates }),
		).toEqual([gemini]);
	});

	it("reconciles zero-duration and killed attempts against live router processes", () => {
		const startedAt = now - HOUR_MS;
		const common = { ...model, attempt: 1, startedAt, event: "launch" };
		const done = { ...common, runId: "done", routePid: 20 };
		const legacy = { ...common, runId: "legacy", briefName: "queued-work" };
		const killed = { ...common, runId: "killed", routePid: 30 };

		expect(
			readLedger(
				[done, legacy, killed, { ...done, event: "outcome", endedAt: startedAt }],
				now,
				new Map([
					[20, ["gemini-4-neon:medium"]],
					[40, ["gemini-4-neon:medium", "/tmp/queued-work.md"]],
				]),
			),
		).toEqual({
			runs: [],
			active: [{ ...model, start: startedAt, end: now + HOUR_MS, running: true }],
		});
	});

	it("paces through the weekly reset while short windows refill", () => {
		const hour = HOUR_MS;
		const tick = hour / 4;
		const week = 168 * hour;
		const everyFiveHours = 5 * hour;
		const simulatedBurns = new Map([
			[burnKey(model, weekly), { ...burn, perRun: 1 }],
			[burnKey(model, short), { ...burn, perRun: 3 }],
		]);
		let weekUsed = 0;
		let shortUsed = 0;

		for (let elapsed = 0; elapsed < week; elapsed += tick) {
			if (elapsed % everyFiveHours === 0) {
				shortUsed = 0;
			}

			const nextShortReset = elapsed - (elapsed % everyFiveHours) + everyFiveHours;
			const candidate = {
				...gemini,
				windows: [
					{ id: weekly, usedPct: weekUsed, resetAt: now + week, duration: week },
					{
						id: short,
						usedPct: shortUsed,
						resetAt: now + nextShortReset,
						duration: everyFiveHours,
					},
				],
			};
			const count = recommend({
				...context,
				now: now + elapsed,
				candidates: [candidate],
				burns: simulatedBurns,
			}).length;

			weekUsed += count;
			shortUsed += 3 * count;
			expect(Math.max(weekUsed, shortUsed)).toBeLessThan(100);
		}

		expect(weekUsed).toBeGreaterThanOrEqual(95);
	});

	it("calibrates percentage points from stable, single-model intervals", () => {
		const intervals = [0, 1, 2, 3, 4, 5];
		const limits: Reading[] = intervals.map((i) => ({
			at: now + (i * HOUR_MS) / 4,
			limits: [
				{
					id: weekly,
					label: "weekly",
					usedPct: 10 + i * 2,
					resetAtMs: now + (i === 5 ? 300 : 150) * HOUR_MS,
				},
			],
		}));
		const runs = intervals.slice(0, 5).map((i) => ({
			...model,
			start: now + (i * HOUR_MS) / 4 + 60_000,
			end: now + (i * HOUR_MS) / 4 + 7 * 60_000,
		}));
		const mixed = { ...model, model: "different", start: now + 60_000, end: now + 7 * 60_000 };

		expect(
			estimateBurn(limits, [...runs, mixed], windowsByPool).get(burnKey(model, weekly)),
		).toEqual({
			perHour: 20,
			perRun: 2,
			hoursPerRun: 0.1,
			samples: 3,
		});
	});
});
