import { getApp } from "$lib/server/app";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => json({ jobs: getApp().queue.jobs() });
