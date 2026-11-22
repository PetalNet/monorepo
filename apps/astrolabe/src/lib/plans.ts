/**
 * Display names for the plans each provider reports. A plan the maps don't know is shown as the
 * provider spells it, so one added upstream still names itself.
 */

/**
 * Every Codex `planType` but `unknown`, named as Codex's status line names it:
 * https://github.com/openai/codex/blob/fea1d7f7d163521a868c344527da79ba0efc146d/codex-rs/tui/src/subscription.rs
 */
const CODEX_PLANS = new Map([
	["free", "Free"],
	["go", "Go"],
	["plus", "Plus"],
	["pro", "Pro 200"],
	["prolite", "Pro 100"],
	["promax", "Pro 500"],
	["team", "Business"],
	["self_serve_business_prolite", "Business Premium"],
	["self_serve_business_usage_based", "Business"],
	["business", "Enterprise"],
	["ent26", "Enterprise"],
	["enterprise_cbp_automation", "Enterprise (Automation)"],
	["enterprise_cbp_usage_based", "Enterprise"],
	["enterprise", "Enterprise"],
	["edu", "Edu"],
	["edu_plus", "Edu Plus"],
	["edu_pro", "Edu Pro"],
	["sci", "Academic Researchers"],
	["sci_plus", "Academic Researchers Plus"],
]);

/** Claude's subscription types, the `subscriptionType` of a Claude Code login. */
const CLAUDE_PLANS = new Map([
	["pro", "Pro"],
	["max", "Max"],
	["team", "Team"],
	["enterprise", "Enterprise"],
]);

/**
 * Claude's rate-limit tiers. Ultra is a `max` subscription on the 20x tier, so only the tier tells
 * it from Max: https://claude.com/pricing
 */
const CLAUDE_TIERS = new Map([
	["default_claude_max_5x", "Max"],
	["default_claude_max_20x", "Ultra"],
]);

export const codexPlanName = (planType: string | null): string | null =>
	planType === null ? null : (CODEX_PLANS.get(planType) ?? planType);

export const claudePlanName = (
	subscriptionType: string | null,
	rateLimitTier: string | null,
): string | null =>
	(rateLimitTier === null ? undefined : CLAUDE_TIERS.get(rateLimitTier)) ??
	(subscriptionType === null ? null : (CLAUDE_PLANS.get(subscriptionType) ?? subscriptionType));
