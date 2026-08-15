import { withRestInvocation } from "$lib/server/invocation";
import { runGrove } from "$lib/server/runtime";
import { sproutApi } from "$lib/server/sprouts/api";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) =>
	runGrove(withRestInvocation(sproutApi.fetch(event.request)), event);
