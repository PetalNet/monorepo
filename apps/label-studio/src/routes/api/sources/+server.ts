import { getApp } from "$lib/server/app";
import { sourceInfo } from "$lib/server/sources";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => json({ sources: sourceInfo(getApp().config) });
