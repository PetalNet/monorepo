import { planWindows, windowKey, type WindowSpan, type WindowSpec } from "$lib/plans";
import type { ReportedWindow, UsageReadout } from "$lib/server/dossier";

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
	/** Provider, span and model, such as `claude-7d-fable`. Also the window's colour class. */
	id: string;
	agent: "Claude" | "Codex";
	span: WindowSpan;
	model: string | null;
	/** The configured plan the window was checked against. */
	plan: string;
	/**
	 * `listed`: the plan lists it and the feed reports it (or there is no feed to check).
	 * `unreported`: the plan lists it but the feed doesn't. `unlisted`: the feed reports it but the
	 * plan doesn't.
	 */
	fit: "listed" | "unreported" | "unlisted";
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
	| "not-reported"
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

	if (window.fit === "unreported") {
		return { ...empty, state: "not-reported" };
	}

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
		// Past the limit, credits keep requests going. Codex sets `rate_limit_reached_type` once the
		// plan's own allowance is spent even while credits carry on, so its `hasCredits` decides; a feed
		// without it falls back to a positive balance and no stop.
		const onCredits =
			window.hasCredits ??
			(window.blockedBy === null && window.credits !== null && window.credits > 0);

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

export interface PlanCheck {
	/** Each agent's plan windows, then any the feed reports beyond them, in that order. */
	windows: LimitWindow[];
	/** Plan disagreements that belong to no single window. */
	notices: string[];
}

/** Matches each agent's live windows against its configured plan. */
export const limitWindowsFrom = (agents: readonly UsageReadout[]): PlanCheck => {
	const windows: LimitWindow[] = [];
	const notices: string[] = [];

	for (const agent of agents) {
		const listed = planWindows(agent.kind, agent.plan);
		const window = (
			spec: WindowSpec,
			reported: ReportedWindow | undefined,
			fit: LimitWindow["fit"],
		): LimitWindow => ({
			id: `${agent.kind}-${windowKey(spec)}`,
			agent: agent.label,
			span: spec.span,
			model: spec.model ?? null,
			plan: agent.plan,
			fit,
			inactive: reported?.inactive ?? false,
			usedPct: reported?.usedPct ?? null,
			resetsAt: ms(reported?.resetsAt ?? null),
			observedAt: ms(agent.observedAt),
			credits: agent.creditsBalance,
			hasCredits: agent.hasCredits,
			blockedBy: agent.limitReachedType,
		});
		const asSpec = (reported: ReportedWindow): WindowSpec =>
			reported.model === null
				? { span: reported.span }
				: { span: reported.span, model: reported.model };

		if (listed === null) {
			notices.push(
				`${agent.label} plan "${agent.plan}" is not in the plan table; showing the limits its feed reports`,
			);
		}

		if (agent.reportedPlan !== null && agent.reportedPlan !== agent.plan) {
			notices.push(
				`${agent.label} reports the ${agent.reportedPlan} plan, but Astrolabe is set to ${agent.plan}`,
			);
		}

		for (const kind of agent.unreadKinds) {
			notices.push(`${agent.label} reports a ${kind} limit Astrolabe does not read`);
		}

		// One window per identity, so each ring and plaque has a unique key. Repeats keep the fullest.
		const reportedByKey = new Map<string, ReportedWindow>();

		for (const reported of agent.windows) {
			const key = windowKey(asSpec(reported));
			const kept = reportedByKey.get(key);

			if (kept !== undefined) {
				notices.push(
					`${agent.label} reports more than one ${[kept.model, kept.span].filter(Boolean).join(" ")} limit; showing the fullest`,
				);
			}

			if (kept === undefined || (reported.usedPct ?? -1) > (kept.usedPct ?? -1)) {
				reportedByKey.set(key, reported);
			}
		}

		const listedKeys = new Set((listed ?? []).map(windowKey));

		for (const spec of listed ?? []) {
			const reported = reportedByKey.get(windowKey(spec));

			windows.push(
				window(spec, reported, agent.read && reported === undefined ? "unreported" : "listed"),
			);
		}

		for (const [key, reported] of reportedByKey) {
			if (!listedKeys.has(key)) {
				// An unknown plan lists nothing, so the feed's windows are all there is to draw.
				windows.push(window(asSpec(reported), reported, listed === null ? "listed" : "unlisted"));
			}
		}
	}

	return { windows, notices: [...new Set(notices)] };
};
