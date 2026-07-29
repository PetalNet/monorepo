import { runGrove } from "$lib/server/runtime";
import { handleMcpRequest } from "$lib/server/sprouts/mcp";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = (event) => runGrove(handleMcpRequest(event.request), event);
