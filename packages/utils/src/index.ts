// @petalnet/utils — pure functions, no deps. Add things here only after they
// land in 2+ apps verbatim. Premature extraction is its own anti-pattern.
//
// Seed with one obviously-shareable helper so the workspace has something
// to typecheck.

/** Coerce arbitrary input to a finite non-negative number, or fall back. */
export const nonneg = (v: unknown, fallback = 0): number => {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Clamp `n` to [`min`, `max`]. */
export const clamp = (n: number, min: number, max: number): number =>
	Math.min(Math.max(n, min), max);

/** Truncate `s` to `max` chars, appending an ellipsis if it had to cut. */
export const truncate = (s: string, max: number): string =>
	s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";

/** Async sleep — usable inside `await`. */
export const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));
