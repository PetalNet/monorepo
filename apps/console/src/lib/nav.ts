/**
 * Canonical sidebar nav (foundations §2.2). This table is the source of truth; order is
 * attention-first (Signals inserted per /task/708). Functional names stay primary; the Good Place
 * lives in signage/tooltips, never the label. Icon ids are current Lucide ids. Terminal is
 * admin-only: HIDDEN (not disabled) for non-admin, a structural wall (/task/694).
 */
import type { Lane } from "$lib/api/types";

export type BadgeKind =
	| "none"
	| "severity" // cockpit: graded by max attention severity, not count
	| "count" // work (review-ready), updates (security-critical)
	| "down"; // agents/hosts: danger dot only on trouble

export interface NavEntry {
	label: string;
	/** Lucide icon id (imported per-icon in the Sidebar). */
	icon: string;
	href: string;
	/** G-then-key quick-nav letter (foundations §3.6); undefined = no shortcut. */
	key?: string;
	badge: BadgeKind;
	/** Sign-face secondary (Good Place signage), shown in tooltip only. */
	sign?: string;
	/** Lane required to see the item at all; undefined = everyone. */
	requiresLane?: Lane;
}

const NAV: NavEntry[] = [
	{ label: "Cockpit", icon: "layout-dashboard", href: "/", key: "c", badge: "severity" },
	{ label: "Work", icon: "kanban", href: "/work", key: "w", badge: "count", sign: "What We Owe" },
	{
		label: "Agents",
		icon: "users-round",
		href: "/agents",
		key: "a",
		badge: "down",
		sign: "Residents",
	},
	{
		label: "Hosts",
		icon: "server",
		href: "/hosts",
		key: "h",
		badge: "down",
		sign: "The Neighborhood",
	},
	{
		label: "Observability",
		icon: "chart-line",
		href: "/observability",
		key: "o",
		badge: "none",
		sign: "Accounting",
	},
	{
		label: "Cost",
		icon: "coins",
		href: "/cost",
		key: "p",
		badge: "count",
		sign: "The Point System",
	},
	{
		label: "Signals",
		icon: "radio-tower",
		href: "/signals",
		key: "s",
		badge: "none",
		sign: "Correspondence",
	},
	{ label: "Network", icon: "door-open", href: "/network", badge: "none", sign: "The Door" },
	{ label: "Updates", icon: "shield-check", href: "/updates", badge: "count", sign: "Reboots" },
	{ label: "Library", icon: "library-big", href: "/library", key: "l", badge: "none" },
	{
		label: "Terminal",
		icon: "square-terminal",
		href: "/terminal",
		badge: "none",
		sign: "Judge's Chambers",
		requiresLane: "term_admin",
	},
];

export function visibleNav(lanes: string[]): NavEntry[] {
	return NAV.filter((n) => !n.requiresLane || lanes.includes(n.requiresLane));
}
