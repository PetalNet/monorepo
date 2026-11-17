/**
 * The usage limits each provider's plan has. The dashboard draws the windows the active plan lists
 * and fills them from the live feeds; a window the feed reports that the plan doesn't list, or the
 * reverse, is shown flagged so a plan change gets noticed.
 */

export type Provider = "claude" | "codex";

export type WindowSpan = "5-hour" | "7-day";

/** One limit window. `model` names a per-model weekly limit, such as Claude's Fable allowance. */
export interface WindowSpec {
	span: WindowSpan;
	model?: string;
}

const FIVE_HOUR: WindowSpec = { span: "5-hour" };
const WEEKLY: WindowSpec = { span: "7-day" };

/**
 * Codex plans are keyed by the `planType` Codex reports, so a mismatch with the configured plan is
 * caught. Claude's usage feed names no plan.
 */
export const PLANS = {
	claude: {
		pro: [FIVE_HOUR, WEEKLY],
		"max-5x": [FIVE_HOUR, WEEKLY],
		// No 5-hour limit on Max 20x since November 2026.
		"max-20x": [WEEKLY, { span: "7-day", model: "Fable" }],
	},
	codex: {
		plus: [FIVE_HOUR, WEEKLY],
		// ChatGPT Pro ($100 and up) reports planType "prolite". OpenAI: "Pro plans currently have no
		// five-hour limit" (learn.chatgpt.com/docs/pricing); the feed reports one weekly window.
		prolite: [WEEKLY],
	},
} as const satisfies Record<Provider, Record<string, readonly WindowSpec[]>>;

/** The plans in use. `CLAUDE_PLAN` and `CODEX_PLAN` override them per deployment. */
export const DEFAULT_PLANS = {
	claude: "max-20x",
	codex: "plus",
} as const satisfies { [P in Provider]: keyof (typeof PLANS)[P] };

/** The plan's windows, or null when the plan is not in the table. */
export const planWindows = (provider: Provider, plan: string): readonly WindowSpec[] | null => {
	const plans: Record<string, readonly WindowSpec[]> = PLANS[provider];

	return Object.hasOwn(plans, plan) ? plans[plan] : null;
};

/**
 * A window's identity, such as `7d-fable`. Model names that differ only in case or punctuation
 * match.
 */
export const windowKey = (spec: WindowSpec): string =>
	[spec.span === "5-hour" ? "5h" : "7d", spec.model?.toLowerCase().replaceAll(/\W+/g, "-")]
		.filter(Boolean)
		.join("-");
