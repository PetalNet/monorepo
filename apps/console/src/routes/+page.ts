import { dataMode } from "$lib/api/client";
import { mockCockpit, type CockpitData } from "$lib/data/cockpit";

import type { PageLoad } from "./$types";

/**
 * Cockpit data (foundations §4, §6.2). Mock-default: the live reads it needs (/attention, /roster,
 * comms persistence, crack-source emitters) are 2nd-pass per CONSOLE-CONTRACTS §6.1 — see
 * BLOCKERS.md. The scene comes from the shell layout (?scene=clear|crack|asked) so the same
 * components drive each state.
 */
export const load: PageLoad = async ({ parent }): Promise<{ cockpit: CockpitData }> => {
	const { scene } = await parent();
	const healthScene = scene === "crack" ? "crack" : "clear";
	if (dataMode() === "live") {
		// Honest empty-ish view until the 2nd-pass reads land; no faked freshness.
		return { cockpit: mockCockpit("clear") };
	}
	return { cockpit: mockCockpit(healthScene) };
};
