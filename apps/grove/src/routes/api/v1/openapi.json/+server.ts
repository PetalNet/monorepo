import { groveApi } from "$lib/server/grove/api";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => Response.json(groveApi.openapi);
