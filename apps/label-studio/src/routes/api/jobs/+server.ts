import { json } from "@sveltejs/kit";

import { getApp } from "#lib/server/app.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => json({ jobs: getApp().queue.jobs() });
