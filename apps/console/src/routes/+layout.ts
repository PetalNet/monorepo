import { dataMode, readMe } from "$lib/api/client";
import type { Me } from "$lib/api/types";
import { mockCockpit, type Scene, type ShellHealth } from "$lib/data/cockpit";
import { me as mockMe } from "$lib/data/mock";

import type { LayoutLoad } from "./$types";

export interface ShellData {
	me: Me;
	health: ShellHealth;
	scene: Scene;
}

/**
 * Shell load: the caller's identity (session chip + lane gating) and the fleet-wide health that
 * drives the sidebar state line on every surface. Mock mode composes both from fixtures; live mode
 * reads /me (the health verdict wires to /attention + bus freshness once those 2nd-pass reads land
 * — see BLOCKERS.md). A `?scene=` param drives the demo scenes for board review.
 */
export const load: LayoutLoad = async ({ url, fetch }): Promise<ShellData> => {
	const sceneParam = url.searchParams.get("scene");
	const scene: Scene =
		sceneParam === "crack" ? "crack" : sceneParam === "asked" ? "asked" : "clear";
	const healthScene: Scene = scene === "crack" ? "crack" : "clear";

	if (dataMode() === "live") {
		const me = await readMe(fetch);
		// Live health verdict is 2nd-pass (needs /attention + bus freshness);
		// until then the shell renders "Can't verify" honestly rather than faking.
		const health: ShellHealth = {
			verdict: "cant_verify",
			stateFact: "Bus not connected.",
			badges: {},
		};
		return { me, health, scene };
	}

	const c = mockCockpit(healthScene);
	const health: ShellHealth = { verdict: c.verdict, stateFact: c.stateFact, badges: c.badges };
	return { me: mockMe, health, scene };
};
