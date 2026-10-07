import process from "node:process";

import { dev } from "$app/env";

// Production-safe guards stay outside the build-banned dev implementation directory.
export const groveOrbDevAuthFlagEnabled = () => process.env.GROVE_ORB_DEV_AUTH === "1";

export const groveDevControlPlaneEnabled = () => dev && groveOrbDevAuthFlagEnabled();

export const devRouteNotFound = () => new Response("Not found", { status: 404 });
