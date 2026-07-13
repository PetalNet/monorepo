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
export type Scene = "clear" | "crack" | "asked";

/** Per-nav-href badge value: number => count, "down"/"p0" => danger dot. */
export type NavBadges = Record<string, number | "down" | "p0" | null>;

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
	hud: { needYou: number; inFlight: number; hostsUp: number; hostsDown: number };
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
		hud: { needYou: 0, inFlight: 0, hostsUp: 0, hostsDown: 0 },
		attention: [],
		railHosts: [],
		comms: [],
		saved: [],
	};
}

/** Build the cockpit view model for a scene (mock mode). */
export function mockCockpit(scene: Scene): CockpitData {
	const now = Date.now();
	const fleet = scene === "crack" ? mock.fleetCracked : mock.fleet;
	const attentionRaw = scene === "crack" ? mock.attentionCracked : mock.attentionEmpty;
	const active = attentionSort(attentionRaw.filter((a) => isActiveAttention(a, now)));
	const inFlight = fleet.filter((f) => fleetPresence(f, now) === "working").length;
	const hostsUp = mock.railHosts.filter((h) => !h.dark).length;
	const activeP0 = active.filter((a) => a.grade === "p0").length;

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
	const reviewReady = 3; // mock: review-ready task count (tasks land with the Work surface)

	const stateFact =
		verdict === "cracked"
			? (active[0]?.summary ?? null)
			: verdict === "cant_verify"
				? "Bus silent."
				: null;

	const badges: NavBadges = {
		"/": activeP0 > 0 ? "p0" : null,
		"/work": reviewReady,
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
		hud: { needYou: active.length, inFlight, hostsUp, hostsDown: 0 },
		attention: active,
		railHosts: mock.railHosts,
		comms: mock.comms,
		saved: mock.savedDashboards,
	};
}
