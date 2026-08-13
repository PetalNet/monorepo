import process from "node:process";

import { dev } from "$app/env";

export const groveDevelopmentBuild = dev;

export const isGroveDevControlPlaneEnabled = (development: boolean, flag: string | undefined) =>
	development && flag === "1";

export const groveOrbDevAuthFlagEnabled = () => process.env.GROVE_ORB_DEV_AUTH === "1";

export const groveDevControlPlaneEnabled = () =>
	isGroveDevControlPlaneEnabled(groveDevelopmentBuild, process.env.GROVE_ORB_DEV_AUTH);

export const devRouteNotFound = () => new Response("Not found", { status: 404 });
