import { getApp } from "#lib/server/app.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => Response.json({ jobs: getApp().queue.jobs() });
