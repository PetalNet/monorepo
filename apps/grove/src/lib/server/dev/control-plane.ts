import process from "node:process";

import { dev } from "$app/env";

const returnToBase = "https://grove.invalid";

export const isGroveDevControlPlaneEnabled = (development: boolean, flag: string | undefined) =>
	development && flag === "1";

export const groveDevControlPlaneEnabled = () =>
	isGroveDevControlPlaneEnabled(dev, process.env.GROVE_ORB_DEV_AUTH);

export const devRouteNotFound = () => new Response("Not found", { status: 404 });

export const safeReturnTo = (candidate: string | null | undefined) => {
	if (!candidate?.startsWith("/") || candidate.startsWith("//")) return "/";
	try {
		const parsed = new URL(candidate, returnToBase);
		return parsed.origin === returnToBase
			? `${parsed.pathname}${parsed.search}${parsed.hash}`
			: "/";
	} catch {
		return "/";
	}
};

export const devEndpointInventory = (origin: string) => ({
	status: "development-only" as const,
	productionBoundary:
		"Every endpoint in this inventory returns 404 unless SvelteKit development mode and GROVE_ORB_DEV_AUTH=1 are both active.",
	instructions: {
		ensureServices: ".agents/ensure-grove",
		portalManifests: ".amp/portals/grove.json and .amp/portals/grove-oidc.json",
		logs: ".amp/in/grove.log, .amp/in/grove-oidc.log, and .amp/in/grove-browser.log",
	},
	endpoints: {
		index: { method: "GET", href: `${origin}/__dev` },
		login: {
			method: "GET",
			href: `${origin}/__dev/log-me-in/operator?returnTo=/`,
			behavior:
				"Redirect alias into the real auto-approved Authorization Code + PKCE + nonce OIDC flow; expect OIDC redirects before the returnTo path.",
		},
		logout: {
			method: "GET",
			href: `${origin}/__dev/log-me-out?returnTo=/`,
			behavior: "Deletes the Better Auth session, clears its browser cookie, then redirects.",
		},
		preflight: { method: "GET", href: `${origin}/__dev/preflight` },
		browserLogs: { method: "POST", href: `${origin}/__dev/logs/browser` },
	},
});
