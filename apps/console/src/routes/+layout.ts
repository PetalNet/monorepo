import { dataMode, readHealth, readMe } from "$lib/api/client";
import { consoleHealthBusAgeS } from "$lib/api/derive";
import type { ConsoleHealth, Me } from "$lib/api/types";
import { mockCockpit, type Scene, type ShellHealth } from "$lib/data/cockpit";
import { me as mockMe } from "$lib/data/mock";
import { captureCaughtFailure } from "$lib/glitchtip";

import type { LayoutLoad } from "./$types";

export interface ShellData {
	me: Me;
	health: ShellHealth;
	scene: Scene;
	/** False = live mode but console-api is unreachable — degrade honestly dark. */
	connected: boolean;
}

function liveShellHealth(value: ConsoleHealth | null): ShellHealth {
	if (!value) return { verdict: "cant_verify", stateFact: "Health read unavailable.", badges: {} };
	if (value.lake === "down")
		return { verdict: "cant_verify", stateFact: "Telemetry lake unreachable.", badges: {} };
	const busAgeS = consoleHealthBusAgeS(value);
	if (busAgeS !== null && busAgeS <= 90) return { verdict: "fine", stateFact: null, badges: {} };
	return {
		verdict: "cant_verify",
		stateFact: "Lake reachable; live bridge evidence unavailable.",
		badges: {},
	};
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
 * reads /me and /health independently, grading only explicit bridge proof as healthy. If
 * console-api is unreachable, the shell degrades to an offline principal instead of crashing. A
 * `?scene=` param drives the demo scenes.
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
			const [me, healthRead] = await Promise.all([
				readMe(fetch),
				readHealth(fetch).catch((error) => {
					captureCaughtFailure(error, { surface: "cockpit-shell", endpoint: "/health" });
					return null;
				}),
			]);
			const health = liveShellHealth(healthRead);
			return { me, health, scene, connected: true };
		} catch (error) {
			captureCaughtFailure(error, { surface: "cockpit-shell", endpoint: "/me" });
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
