import { loopApi } from "$lib/server/loop/api";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => Response.json(loopApi.openapi);
