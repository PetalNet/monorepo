import { groveApi } from "$lib/server/api";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => Response.json(groveApi.openapi);
