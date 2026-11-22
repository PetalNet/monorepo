import type { ReportedWindow, UsageReadout, WindowSpan } from "#lib/server/dossier.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Projections from less than this share of a window are noise, so the reading says so instead. */
const MIN_ELAPSED_TO_PROJECT = 0.05;

const WINDOW_MS: Record<WindowSpan, number> = {
	"5-hour": 5 * HOUR_MS,
	"7-day": 7 * 24 * HOUR_MS,
};

/**
 * One usage limit as the feeds report it. `usedPct` is percent of the limit used, never percent
 * left.
 */
export interface LimitWindow {
	/** Provider and limit, such as `claude-7d-fable`. The dials and rows colour a limit by it. */
	id: string;
	/** The provider's display name, such as "Claude". */
	provider: string;
	/** The limit's name within its provider, such as "Fable 7-day". */
	name: string;
	/** The dial the limit is drawn on. A limit with none has no ring and no pace. */
	span: WindowSpan | null;
	/** The provider says this limit is not active. */
	inactive: boolean;
	usedPct: number | null;
	/** Epoch ms the window resets at. */
	resetsAt: number | null;
	/** Epoch ms the usage figure was true at. Codex's figure can be hours older than its scrape. */
	observedAt: number | null;
	/** Prepaid credits that carry on past 100%. Null when the agent has none to draw on. */
	credits: number | null;
	/** The provider's own word on whether credits are carrying requests, when it gives one. */
	hasCredits: boolean | null;
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
	| "too-early"
	| "unpaced";

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

	if (
		window.usedPct === null ||
		window.observedAt === null ||
		(window.span !== null && window.resetsAt === null)
	) {
		return { ...empty, state: "no-reading" };
	}

	if (window.resetsAt !== null && window.resetsAt <= now) {
		// The window rolled over after the figure was taken, so the figure describes a finished window.
		return { ...empty, state: "reset-since-reading" };
	}

	// Usage can run past the limit, such as mobile data after its priority allowance.
	const usedPct = Math.max(0, window.usedPct);
	const used = {
		...empty,
		usedPct,
		leftPct: Math.max(0, 100 - usedPct),
		resetsAt: window.resetsAt,
	};
	// Past the limit, credits keep requests going. Codex sets `rate_limit_reached_type` once the
	// plan's own allowance is spent even while credits carry on, so its `hasCredits` decides; a feed
	// without it falls back to a positive balance and no stop.
	const onCredits =
		window.hasCredits ??
		(window.blockedBy === null && window.credits !== null && window.credits > 0);

	if (window.span === null || window.resetsAt === null) {
		// No window length to measure a burn rate against.
		return {
			...used,
			state: usedPct < 100 ? "unpaced" : onCredits ? "on-credits" : "limit-reached",
		};
	}

	const duration = WINDOW_MS[window.span];
	const startsAt = window.resetsAt - duration;
	const reading = { ...used, startsAt, elapsed: clamp((now - startsAt) / duration, 0, 1) };

	if (usedPct >= 100) {
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

export interface ProviderLimits {
	/** One window per identity, in the order the feed reports them. */
	windows: LimitWindow[];
	/** What the feed reports that no window shows. */
	notes: string[];
}

const STATUS_NOTES: Record<UsageReadout["status"], string | null> = {
	ok: null,
	"signed-out": "Signed out",
	error: "Reading failed",
};

/** A provider's limits, exactly the ones its feed reports. */
export const limitsFrom = (provider: UsageReadout): ProviderLimits => {
	const notes = [
		STATUS_NOTES[provider.status],
		...provider.unreadKinds.map((kind) => `Reports a ${kind} limit Astrolabe does not read`),
	].filter((note) => note !== null);
	// One window per key, so each ring and row has a unique one. Repeats keep the fullest.
	const reportedByKey = new Map<string, ReportedWindow>();

	for (const reported of provider.windows) {
		const kept = reportedByKey.get(reported.key);

		if (kept !== undefined) {
			notes.push(`Reports more than one ${kept.name} limit; showing the fullest`);
		}

		if (kept === undefined || (reported.usedPct ?? -1) > (kept.usedPct ?? -1)) {
			reportedByKey.set(reported.key, reported);
		}
	}

	return {
		windows: Array.from(reportedByKey, ([key, reported]) => ({
			id: `${provider.kind}-${key}`,
			provider: provider.label,
			name: reported.name,
			span: reported.span,
			inactive: reported.inactive,
			usedPct: reported.usedPct,
			resetsAt: ms(reported.resetsAt),
			observedAt: ms(provider.observedAt),
			credits: provider.creditsBalance,
			hasCredits: provider.hasCredits,
			blockedBy: provider.limitReachedType,
		})),
		notes: [...new Set(notes)],
	};
};
