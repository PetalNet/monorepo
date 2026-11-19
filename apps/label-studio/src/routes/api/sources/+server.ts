import { getApp } from "#lib/server/app.ts";
import { sourceInfo } from "#lib/server/sources/index.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => Response.json({ sources: sourceInfo(getApp().config) });
