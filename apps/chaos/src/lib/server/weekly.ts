export type Level = "quiet" | "busy" | "heavy";

export interface Ranked {
	/** The current period's count. */
	value: number;
	/** How many baseline periods had a strictly lower count. */
	quieter: number;
	level: Level;
	/** The median of the baseline periods. */
	median: number;
	/** Oldest first, ending with the current period. */
	series: { end: string; value: number }[];
}

/**
 * What a dial shows. `of` is the number of baseline periods the current one is compared with. Only
 * `reading` carries a needle: `stale` has no current data, and `short` has too little history to
 * compare against, so neither invents a position.
 */
export type Gauge = { of: number } & (
	| { kind: "stale" }
	| { kind: "short"; have: number; need: number; value: number }
	| ({ kind: "reading" } & Ranked)
);

export function addDays(date: string, days: number): string {
	const moved = new Date(`${date}T12:00:00Z`);

	moved.setUTCDate(moved.getUTCDate() + days);

	return moved.toISOString().slice(0, 10);
}

/**
 * Ranks the last period of `series` against the ones before it. Code sets the label from the rank
 * alone: the top tenth of the scale is heavy, the top half busy.
 */
export function rank(series: { end: string; value: number }[]): Ranked {
	const baseline = series.slice(0, -1).map((period) => period.value);
	const value = series.at(-1)?.value ?? 0;
	const quieter = baseline.filter((other) => other < value).length;
	const sorted = baseline.toSorted((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	let level: Level = "quiet";

	if (quieter >= baseline.length * 0.9) {
		level = "heavy";
	} else if (quieter >= baseline.length / 2) {
		level = "busy";
	}

	return {
		value,
		quieter,
		level,
		median:
			sorted.length % 2 === 0
				? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
				: (sorted[middle] ?? 0),
		series,
	};
}

/**
 * The seven days ending on `date` against each of the `weeks` weeks before them, from a record that
 * carries its own dates. `earliest` is the first day the record covers: when it does not reach back
 * far enough to fill the baseline, the result is `short` and no rank is made up.
 */
export function weekly(
	counts: (from: string, to: string) => Map<string, number>,
	earliest: string | undefined,
	date: string,
	weeks = 52,
): Gauge {
	const need = (weeks + 1) * 7;
	const first = addDays(date, 1 - need);
	const have = earliest
		? Math.max(
				0,
				Math.round(
					(Date.parse(`${date}T12:00:00Z`) - Date.parse(`${earliest}T12:00:00Z`)) / 86_400_000,
				) + 1,
			)
		: 0;
	const byDay = counts(first, date);
	const series = Array.from({ length: weeks + 1 }, (_, index) => {
		const start = addDays(first, index * 7);
		let value = 0;

		for (let offset = 0; offset < 7; offset += 1) {
			value += byDay.get(addDays(start, offset)) ?? 0;
		}

		return { end: addDays(start, 6), value };
	});

	if (have < need) {
		return { of: weeks, kind: "short", have, need, value: series.at(-1)?.value ?? 0 };
	}

	return { of: weeks, kind: "reading", ...rank(series) };
}

export type Gap = "noise-ahead" | "risk-ahead" | "level";

/**
 * Compares where two dials sit on their own scales. The noise dial a quarter of a scale or more
 * above the risk dial means coverage is running ahead of the measured risk, and the reverse. With
 * either dial lacking a reading there is nothing to compare.
 */
export function gap(noise: Gauge, risk: Gauge): Gap | undefined {
	if (noise.kind !== "reading" || risk.kind !== "reading") {
		return undefined;
	}

	const difference = noise.quieter / noise.of - risk.quieter / risk.of;

	if (Math.abs(difference) < 0.25) {
		return "level";
	}

	return difference > 0 ? "noise-ahead" : "risk-ahead";
}
