import { groveApi } from "$lib/server/grove/api";
import { runGrove } from "$lib/server/runtime";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) => runGrove(groveApi.fetch(event.request), event);
