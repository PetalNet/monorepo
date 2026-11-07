import type { UsageReadout } from "$lib/server/dossier";

const HOUR_MS = 60 * 60 * 1000;

/** Projections from less than this share of a window are noise, so the reading says so instead. */
const MIN_ELAPSED_TO_PROJECT = 0.05;

export const WINDOW_MS = { "5-hour": 5 * HOUR_MS, "7-day": 7 * 24 * HOUR_MS } as const;

export type WindowSpan = keyof typeof WINDOW_MS;

/**
 * One usage limit as the feeds report it. `usedPct` is percent of the limit used, never percent
 * left.
 */
export interface LimitWindow {
	id: "claude-5h" | "claude-7d" | "codex-7d";
	agent: "Claude" | "Codex";
	span: WindowSpan;
	usedPct: number | null;
	/** Epoch ms the window resets at. */
	resetsAt: number | null;
	/** Epoch ms the usage figure was true at. Codex's figure can be hours older than its scrape. */
	observedAt: number | null;
	/** Prepaid credits that carry on past 100%. Null when the agent has none to draw on. */
	credits: number | null;
	/** The provider's own word that a limit has stopped requests, such as Codex's `primary`. */
	blockedBy: string | null;
}

export type LimitState =
	| "no-reading"
	| "reset-since-reading"
	| "limit-reached"
	| "on-credits"
	| "overshoot"
	| "on-pace"
	| "too-early";

export interface LimitReading {
	window: LimitWindow;
	state: LimitState;
	usedPct: number | null;
	leftPct: number | null;
	/** Window start and reset, epoch ms. */
	startsAt: number | null;
	resetsAt: number | null;
	/** Share of the window that has passed at `now`, 0 to 1. */
	elapsed: number | null;
	/**
	 * Percent of the limit the current burn rate reaches by the reset. Null until a rate is
	 * meaningful.
	 */
	projectedPct: number | null;
	/** When the current burn rate hits 100%, if that is before the reset. */
	runsOutAt: number | null;
	/** Where the dial's red span starts: `runsOutAt` when overshooting, now once the limit is hit. */
	lockoutAt: number | null;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export const readLimit = (window: LimitWindow, now: number): LimitReading => {
	const empty = {
		window,
		usedPct: null,
		leftPct: null,
		startsAt: null,
		resetsAt: null,
		elapsed: null,
		projectedPct: null,
		runsOutAt: null,
		lockoutAt: null,
	};

	if (window.usedPct === null || window.resetsAt === null || window.observedAt === null) {
		return { ...empty, state: "no-reading" };
	}

	const duration = WINDOW_MS[window.span];
	const startsAt = window.resetsAt - duration;

	if (window.resetsAt <= now) {
		// The window rolled over after the figure was taken, so the figure describes a finished window.
		return { ...empty, state: "reset-since-reading" };
	}

	const usedPct = clamp(window.usedPct, 0, 100);
	const reading = {
		window,
		usedPct,
		leftPct: 100 - usedPct,
		startsAt,
		resetsAt: window.resetsAt,
		elapsed: clamp((now - startsAt) / duration, 0, 1),
	};

	if (usedPct >= 100) {
		// Past the limit, credits keep requests going until the provider says it has stopped them.
		const onCredits = window.blockedBy === null && window.credits !== null && window.credits > 0;

		return {
			...reading,
			state: onCredits ? "on-credits" : "limit-reached",
			projectedPct: 100,
			runsOutAt: null,
			lockoutAt: onCredits ? null : now,
		};
	}

	// The burn rate is measured up to when the figure was observed, not up to now.
	const observedElapsed = (window.observedAt - startsAt) / duration;

	if (observedElapsed < MIN_ELAPSED_TO_PROJECT) {
		return {
			...reading,
			state: "too-early",
			projectedPct: null,
			runsOutAt: null,
			lockoutAt: null,
		};
	}

	const projectedPct = usedPct / observedElapsed;
	const runsOutAt =
		projectedPct > 100 && usedPct > 0
			? startsAt + (window.observedAt - startsAt) * (100 / usedPct)
			: null;

	return {
		...reading,
		state: projectedPct > 100 ? "overshoot" : "on-pace",
		projectedPct,
		runsOutAt,
		lockoutAt: runsOutAt,
	};
};

const ms = (seconds: number | null) => (seconds === null ? null : seconds * 1000);

/** Claude's 5-hour and 7-day windows and Codex's 7-day window, in that order. */
export const limitWindowsFrom = (
	agents: readonly UsageReadout[],
): [LimitWindow, LimitWindow, LimitWindow] => {
	const claude = agents.find((agent) => agent.kind === "claude");
	const codex = agents.find((agent) => agent.kind === "codex");
	const window = (
		id: LimitWindow["id"],
		agent: UsageReadout | undefined,
		span: WindowSpan,
	): LimitWindow => ({
		id,
		agent: id.startsWith("claude") ? "Claude" : "Codex",
		span,
		usedPct:
			agent === undefined
				? null
				: span === "5-hour"
					? agent.fiveHourUsedPct
					: agent.sevenDayUsedPct,
		resetsAt:
			agent === undefined
				? null
				: ms(span === "5-hour" ? agent.fiveHourResetsAt : agent.sevenDayResetsAt),
		observedAt: agent === undefined ? null : ms(agent.observedAt),
		credits: agent?.creditsBalance ?? null,
		blockedBy: agent?.limitReachedType ?? null,
	});

	return [
		window("claude-5h", claude, "5-hour"),
		window("claude-7d", claude, "7-day"),
		window("codex-7d", codex, "7-day"),
	];
};
