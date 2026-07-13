import { dataMode, readMe } from "$lib/api/client";
import type { Me } from "$lib/api/types";
import { mockCockpit, type Scene, type ShellHealth } from "$lib/data/cockpit";
import { me as mockMe } from "$lib/data/mock";

import type { LayoutLoad } from "./$types";

export interface ShellData {
	me: Me;
	health: ShellHealth;
	scene: Scene;
	/** False = live mode but console-api is unreachable — degrade honestly dark. */
	connected: boolean;
}

// A disconnected principal: no lanes (controls hidden), no scopes. The shell
// stays up and honest when console-api is down (§1 blast radius: every surface
// is honestly dark, never a crash), rather than throwing a 500 on the load.
const OFFLINE_ME: Me = {
	schema_version: 1,
	kind: "human",
	id: "offline",
	tiers: [],
	lanes: [],
	scopes: [],
	zookie: "",
	display_name: null,
	grant_name: null,
};

/**
 * Shell load: the caller's identity (session chip + lane gating) and the fleet-wide health that
 * drives the sidebar state line on every surface. Mock mode composes both from fixtures; live mode
 * reads /me and, until the 2nd-pass reads land, renders "Can't verify" honestly rather than faking
 * (see BLOCKERS.md). If console-api is unreachable, the shell degrades to an offline principal
 * instead of crashing. A `?scene=` param drives the demo scenes.
 */
export const load: LayoutLoad = async ({ url, fetch }): Promise<ShellData> => {
	const sceneParam = url.searchParams.get("scene");
	const scene: Scene =
		sceneParam === "crack"
			? "crack"
			: sceneParam === "busy"
				? "busy"
				: sceneParam === "asked"
					? "asked"
					: "clear";

	if (dataMode() === "live") {
		try {
			const me = await readMe(fetch);
			const health: ShellHealth = {
				verdict: "cant_verify",
				stateFact: "Bus not connected.",
				badges: {},
			};
			return { me, health, scene, connected: true };
		} catch {
			const health: ShellHealth = {
				verdict: "cant_verify",
				stateFact: "console-api unreachable.",
				badges: {},
			};
			return { me: OFFLINE_ME, health, scene, connected: false };
		}
	}

	const healthScene: Scene = scene === "crack" ? "crack" : scene === "busy" ? "busy" : "clear";
	const c = mockCockpit(healthScene);
	const health: ShellHealth = { verdict: c.verdict, stateFact: c.stateFact, badges: c.badges };
	return { me: mockMe, health, scene, connected: true };
};
