import process from "node:process";

import { dev } from "$app/env";

export const groveDevelopmentBuild = dev;

export const groveOrbDevAuthFlagEnabled = () => process.env.GROVE_ORB_DEV_AUTH === "1";

export const groveDevControlPlaneEnabled = () =>
	groveDevelopmentBuild && groveOrbDevAuthFlagEnabled();

export const devRouteNotFound = () => new Response("Not found", { status: 404 });
