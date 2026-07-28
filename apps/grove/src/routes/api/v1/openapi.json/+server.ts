import { sproutApi } from "$lib/server/sprouts/api";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => Response.json(sproutApi.openapi);
