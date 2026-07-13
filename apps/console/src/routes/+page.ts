import { dataMode } from "$lib/api/client";
import { liveEmptyCockpit, mockCockpit, type CockpitData } from "$lib/data/cockpit";

import type { PageLoad } from "./$types";

/**
 * Cockpit data (foundations §4, §6.2). Mock-default: the live reads it needs (/attention, /roster,
 * comms persistence, crack-source emitters) are 2nd-pass per CONSOLE-CONTRACTS §6.1 — see
 * BLOCKERS.md. The scene comes from the shell layout (?scene=clear|crack|asked) so the same
 * components drive each state. In live mode we render an honest "can't verify" placeholder, never
 * fabricated fixtures (lore veto #20).
 */
export const load: PageLoad = async ({ parent }): Promise<{ cockpit: CockpitData }> => {
	const { scene, me } = await parent();
	if (dataMode() === "live") {
		return { cockpit: liveEmptyCockpit(me.display_name ?? me.id) };
	}
	const healthScene = scene === "crack" ? "crack" : scene === "busy" ? "busy" : "clear";
	return { cockpit: mockCockpit(healthScene) };
};
