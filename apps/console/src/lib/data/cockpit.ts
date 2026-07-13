/**
 * Cockpit view-model composer — the ONE place the cockpit's shell bindings are assembled
 * (foundations §6.2). In mock mode it reads fixtures; in live mode it reads the query/entity planes
 * and applies the shared derivations. Same view model either way, so the components never branch on
 * data source.
 */
import {
	attentionSort,
	fleetPresence,
	healthVerdict,
	isActiveAttention,
	type HealthVerdict,
} from "$lib/api/derive";
import type { AttentionItem, CommsEvent } from "$lib/api/types";

import * as mock from "./mock";

/** Demo scenes for the shell (drives real components with different fixtures). */
export type Scene = "clear" | "busy" | "crack" | "asked";

/**
 * Per-nav-href badge value: a number => count; a severity token => a graded dot ("p0"/"down"
 * danger, "warn" warn, "muted" text-3). The Cockpit badge is graded by the MAX severity of the
 * attention set, not its count (foundations §2.2).
 */
export type NavBadges = Record<string, number | "down" | "p0" | "warn" | "muted" | null>;

export interface ShellHealth {
	verdict: HealthVerdict;
	/** Crack fact (first P0 summary) or "Bus silent Nm." for can't-verify. */
	stateFact: string | null;
	badges: NavBadges;
}

export interface CockpitData extends ShellHealth {
	scene: Scene;
	greetingName: string;
	/**
	 * False = the cockpit's live reads (attention/roster/comms) are not connected yet (2nd-pass,
	 * §6.1). The page renders an honest "can't verify" state rather than fabricated fixtures — never
	 * fake state (lore veto #20).
	 */
	connected: boolean;
	/** NeedsNew = unacked active items; needsHeld = acked ("held") items. §4.4 split. */
	hud: {
		needsNew: number;
		needsHeld: number;
		inFlight: number;
		hostsUp: number;
		hostsDown: number;
	};
	attention: AttentionItem[];
	railHosts: mock.RailHost[];
	comms: CommsEvent[];
	saved: mock.SavedDashboard[];
}

/**
 * Live-mode placeholder until the cockpit's 2nd-pass reads land (§6.1). No fabricated
 * rail/board/mail — the shell says "Can't verify" and means it.
 */
export function liveEmptyCockpit(greetingName: string): CockpitData {
	return {
		scene: "clear",
		greetingName,
		connected: false,
		verdict: "cant_verify",
		stateFact: "Bus not connected.",
		badges: {},
		hud: { needsNew: 0, needsHeld: 0, inFlight: 0, hostsUp: 0, hostsDown: 0 },
		attention: [],
		railHosts: [],
		comms: [],
		saved: [],
	};
}

/** Max-severity token for the Cockpit nav badge over an attention set (§2.2). */
function cockpitSeverity(items: AttentionItem[]): "p0" | "warn" | "muted" | null {
	if (items.length === 0) return null;
	if (items.some((a) => a.grade === "p0")) return "p0";
	if (items.some((a) => a.grade === "blocker")) return "warn";
	return "muted";
}

/** Build the cockpit view model for a scene (mock mode). */
export function mockCockpit(scene: Scene): CockpitData {
	const now = Date.now();
	const fleet = scene === "crack" ? mock.fleetCracked : mock.fleet;
	const attentionRaw =
		scene === "crack"
			? mock.attentionCracked
			: scene === "busy"
				? mock.attentionBusy
				: mock.attentionEmpty;
	const active = attentionSort(attentionRaw.filter((a) => isActiveAttention(a, now)));
	const inFlight = fleet.filter((f) => fleetPresence(f, now) === "working").length;
	const hostsUp = mock.railHosts.filter((h) => !h.dark).length;
	const activeP0 = active.filter((a) => a.grade === "p0").length;
	const needsNew = active.filter((a) => !a.acked_by).length;
	const needsHeld = active.filter((a) => a.acked_by).length;

	const verdict = healthVerdict({
		busHeartbeatAgeS: 8, // fresh bus frame (positive evidence)
		fleetSnapshotAgeS: 5,
		activeP0Count: activeP0,
		activeAttentionCount: active.length,
	});

	const anyCrashed = scene === "crack";
	const securityCritical = mock.boxUpdates.reduce(
		(n, b) => n + (b.security_critical_count ?? 0),
		0,
	);
	const reviewReady =
		active.filter((a) => a.grade === "review").length || (scene === "clear" ? 3 : 0);

	const stateFact =
		verdict === "cracked"
			? (active[0]?.summary ?? null)
			: verdict === "cant_verify"
				? "Bus silent."
				: verdict === "needs_you"
					? needsNew === 0
						? // Everything acked, nothing new — held, not "0 need you".
							`Mostly fine. ${needsHeld} held, nothing new.`
						: needsNew === 1
							? "Mostly fine. One thing needs you."
							: `Mostly fine. ${needsNew} things need you.`
					: null;

	const badges: NavBadges = {
		"/": cockpitSeverity(active),
		"/work": reviewReady || null,
		"/agents": anyCrashed ? "down" : null,
		// Hosts badge is host-trouble only; a dark/idle box is not trouble. No
		// host-down in the mock scenes (the crack is an agent crash).
		"/hosts": null,
		"/updates": securityCritical > 0 ? securityCritical : null,
	};

	return {
		scene,
		greetingName: mock.me.display_name ?? "there",
		connected: true,
		verdict,
		stateFact,
		badges,
		hud: { needsNew, needsHeld, inFlight, hostsUp, hostsDown: 0 },
		attention: active,
		railHosts: mock.railHosts,
		comms: mock.comms,
		saved: mock.savedDashboards,
	};
}
