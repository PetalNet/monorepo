import type { Principal } from "./principal.ts";

export const CONSOLE_TIERS = ["owner", "operator", "editor", "viewer"] as const;
export type ConsoleTier = (typeof CONSOLE_TIERS)[number];

const lanesByTier = {
	owner: ["viewer", "editor", "operator", "admin"],
	operator: ["viewer", "editor", "operator"],
	editor: ["viewer", "editor"],
	viewer: ["viewer"],
} as const satisfies Record<ConsoleTier, readonly Principal["lanes"][number][]>;

export function isConsoleTier(value: unknown): value is ConsoleTier {
	return typeof value === "string" && CONSOLE_TIERS.some((tier) => tier === value);
}

/** Terminal administration is deliberately non-hierarchical and never inherited from owner. */
export function lanesForTier(tier: ConsoleTier): Principal["lanes"] {
	return [...lanesByTier[tier]];
}
