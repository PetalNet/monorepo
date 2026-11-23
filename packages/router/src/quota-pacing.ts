import type { QuotaLimit } from "@petalnet/harness-hooks/quota-sources";

export const HOUR_MS = 3_600_000;
export const CHECK_INTERVAL_MS = HOUR_MS / 4;
const RESET_SKEW_MS = 30_000;
const MIN_SAMPLE_MS = 5 * 60_000;
const TARGET_PCT = 97;
const EMPTY_WINDOW_LIMIT_PCT = 25;

export interface Reading {
	at: number;
	scope?: string;
	limits: QuotaLimit[];
}

export interface Builder {
	pool: string;
	model: string;
	effort: string;
}

export interface Run extends Builder {
	start: number;
	end: number;
	running?: true;
}

interface Observation {
	spend: number;
	hours: number;
	runs: number;
}

export interface Burn {
	perHour: number;
	perRun: number;
	hoursPerRun: number;
	samples: number;
}

export function burnKey(builder: Builder, window: string): string {
	return JSON.stringify([builder.pool, builder.model, builder.effort, window]);
}

function quantile(values: number[], fraction: number): number {
	const sorted = values.toSorted((a, b) => a - b);

	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function estimateBurn(
	readings: Reading[],
	runs: Run[],
	windowsByPool: ReadonlyMap<string, string[]>,
): Map<string, Burn> {
	const series = new Map<string, Observation[]>();
	const previous = new Map<string, { limit: QuotaLimit; at: number }>();

	for (const { at, limits } of readings.toSorted((a, b) => a.at - b.at)) {
		for (const limit of limits) {
			const before = previous.get(limit.id);

			if (
				before &&
				at - before.at < MIN_SAMPLE_MS &&
				limit.resetAtMs === before.limit.resetAtMs &&
				limit.usedPct >= before.limit.usedPct
			) {
				continue;
			}

			previous.set(limit.id, { limit, at });

			if (
				!before ||
				at - before.at < MIN_SAMPLE_MS ||
				at - before.at > HOUR_MS ||
				!limit.resetAtMs ||
				at >= limit.resetAtMs ||
				!before.limit.resetAtMs ||
				Math.abs(limit.resetAtMs - before.limit.resetAtMs) > RESET_SKEW_MS ||
				limit.usedPct < before.limit.usedPct ||
				limit.usedPct >= 100
			) {
				continue;
			}

			const overlapping = runs.filter(
				(run) =>
					run.start < at && run.end > before.at && windowsByPool.get(run.pool)?.includes(limit.id),
			);

			if (overlapping.some((run) => run.running)) {
				continue;
			}

			const work = new Map<string, { hours: number; runs: number }>();

			for (const run of overlapping) {
				const key = burnKey(run, limit.id);
				const duration = Math.min(at, run.end) - Math.max(before.at, run.start);
				const reading = work.get(key) ?? { hours: 0, runs: 0 };

				reading.hours += duration / HOUR_MS;
				reading.runs += duration / (run.end - run.start);
				work.set(key, reading);
			}

			const totalHours = Array.from(work.values()).reduce((sum, value) => sum + value.hours, 0);

			for (const [key, exposure] of work) {
				if (exposure.hours >= Math.max(1 / 60, totalHours * 0.6) && exposure.runs >= 0.5) {
					const observations = series.get(key) ?? [];

					observations.push({ spend: limit.usedPct - before.limit.usedPct, ...exposure });
					series.set(key, observations);
				}
			}
		}
	}

	const burns = new Map<string, Burn>();

	for (const [key, observations] of series) {
		if (observations.length < 3 || observations.filter((o) => o.spend > 0).length < 2) {
			continue;
		}

		const total = observations.reduce(
			(sum, o) => ({
				spend: sum.spend + o.spend,
				hours: sum.hours + o.hours,
				runs: sum.runs + o.runs,
			}),
			{ spend: 0, hours: 0, runs: 0 },
		);

		burns.set(key, {
			perHour: Math.max(
				total.spend / total.hours,
				quantile(
					observations.map((o) => o.spend / o.hours),
					0.8,
				),
			),
			perRun: Math.max(
				total.spend / total.runs,
				quantile(
					observations.map((o) => o.spend / o.runs),
					0.9,
				),
			),
			hoursPerRun: quantile(
				observations.map((o) => o.hours / o.runs),
				0.9,
			),
			samples: observations.length,
		});
	}

	return burns;
}

export interface Window {
	id: string;
	usedPct: number;
	resetAt: number;
	idle?: true;
	duration: number;
}

export interface Candidate extends Builder {
	provider: string;
	windows: Window[];
}

interface PaceInput {
	now: number;
	slots: number;
	candidates: Candidate[];
	active: Builder[];
	burns: ReadonlyMap<string, Burn>;
	providerCaps: ReadonlyMap<string, number>;
	poolProviders: ReadonlyMap<string, string>;
	windowsByPool: ReadonlyMap<string, string[]>;
}

function cost(burn: Burn): number {
	// Meters are rounded. Leave one additional point available for unobserved spend.
	return Math.max(1, burn.perRun, burn.perHour * burn.hoursPerRun);
}

export function hostSlots(availableMiB: number, diskMiB: number, activeBuilders: number): number {
	return diskMiB < 8_000
		? 0
		: Math.max(0, Math.floor((availableMiB - 2_500) / 3_072) - activeBuilders);
}

export function recommend(input: PaceInput): Candidate[] {
	const { now, slots, candidates, burns, providerCaps, poolProviders, windowsByPool } = input;
	const committed = [...input.active];
	const selected: Candidate[] = [];

	for (let slot = 0; slot < slots; slot++) {
		let best: { candidate: Candidate; priority: number } | undefined;
		const eligiblePools = new Set<string>();

		for (const candidate of candidates) {
			if (eligiblePools.has(candidate.pool)) {
				continue;
			}

			const active = committed.filter((run) => poolProviders.get(run.pool) === candidate.provider);
			const cap = providerCaps.get(candidate.provider) ?? 0;

			if (active.length >= cap || candidate.windows.length === 0) {
				continue;
			}

			let priority = 0;
			const fits = candidate.windows.every((window) => {
				const burn = burns.get(burnKey(candidate, window.id));
				const untilReset = window.idle ? window.duration : window.resetAt - now;
				const remaining = Math.min(untilReset, window.duration);

				if (!burn || remaining <= 0 || untilReset > window.duration + RESET_SKEW_MS) {
					return false;
				}

				const ownCost = cost(burn);
				const reserved = committed
					.filter((run) => windowsByPool.get(run.pool)?.includes(window.id))
					.reduce((sum, run) => {
						const rate = burns.get(burnKey(run, window.id));

						return rate ? sum + cost(rate) : Infinity;
					}, 0);

				// The next decision controls another launch, while this run can outlast that decision.
				const horizon = Math.max(CHECK_INTERVAL_MS, burn.hoursPerRun * HOUR_MS);
				const elapsed = window.duration - remaining;
				const target = TARGET_PCT * Math.min(1, (elapsed + horizon) / window.duration);
				const startup = window.usedPct === 0 && reserved === 0 && ownCost <= EMPTY_WINDOW_LIMIT_PCT;

				if (!startup && (window.idle || window.usedPct + reserved + ownCost > target)) {
					return false;
				}

				if (window.duration > 5 * HOUR_MS) {
					priority += Math.max(0, TARGET_PCT - window.usedPct - reserved) / (remaining / HOUR_MS);
				}

				return true;
			});

			if (fits) {
				eligiblePools.add(candidate.pool);

				if (!best || priority > best.priority) {
					best = { candidate, priority };
				}
			}
		}

		if (!best) {
			break;
		}

		selected.push(best.candidate);
		committed.push(best.candidate);
	}

	return selected;
}
