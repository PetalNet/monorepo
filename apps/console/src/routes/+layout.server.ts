import { consoleHealthBusAgeS } from "$lib/api/derive";
import type { ConsoleHealth, Me } from "$lib/api/types";
import { mockCockpit, type Scene, type ShellHealth } from "$lib/data/cockpit";
import { me as mockMe } from "$lib/data/mock";
import { captureCaughtFailure } from "$lib/glitchtip";
import { dataMode, readHealth, readMe } from "$lib/rpc/browser";
import { error, redirect } from "@sveltejs/kit";

import type { LayoutServerLoad } from "./$types";

export interface ShellData {
	authenticated: boolean;
	me: Me;
	health: ShellHealth;
	scene: Scene;
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

/**
 * The shell is server-only and fail-closed. The login route returns before any console API read;
 * every other route requires the session established by hooks.server before shell data is loaded.
 */
export const load: LayoutServerLoad = async ({ url, fetch, locals }): Promise<ShellData> => {
	if (url.pathname === "/login") {
		if (url.searchParams.has("error"))
			captureCaughtFailure(new Error("OIDC callback returned an authentication error"), {
				surface: "console-login",
				endpoint: "/api/auth/oauth2/callback/authentik",
			});
		return {
			authenticated: false,
			// The root layout never reads these values while unauthenticated. Keeping a stable parent-data
			// shape means protected child routes do not need impossible nullable identity branches.
			me: null as never,
			health: null as never,
			scene: "clear",
			connected: false,
		};
	}
	if (!locals.session || !locals.user) redirect(303, "/login");

	const sceneParam = url.searchParams.get("scene");
	const scene: Scene =
		sceneParam === "crack"
			? "crack"
			: sceneParam === "busy"
				? "busy"
				: sceneParam === "asked"
					? "asked"
					: "clear";
	if (dataMode() !== "live") {
		const healthScene: Scene = scene === "crack" ? "crack" : scene === "busy" ? "busy" : "clear";
		const cockpit = mockCockpit(healthScene);
		return {
			authenticated: true,
			me: mockMe,
			health: {
				verdict: cockpit.verdict,
				stateFact: cockpit.stateFact,
				badges: cockpit.badges,
			},
			scene,
			connected: true,
		};
	}

	try {
		const [me, healthRead] = await Promise.all([
			readMe(fetch),
			readHealth(fetch).catch((cause: unknown) => {
				captureCaughtFailure(cause, { surface: "cockpit-shell", endpoint: "/health" });
				return null;
			}),
		]);
		return {
			authenticated: true,
			me,
			health: liveShellHealth(healthRead),
			scene,
			connected: true,
		};
	} catch (cause) {
		captureCaughtFailure(cause, { surface: "cockpit-shell", endpoint: "/me" });
		error(503, "Console data is temporarily unavailable.");
	}
};
