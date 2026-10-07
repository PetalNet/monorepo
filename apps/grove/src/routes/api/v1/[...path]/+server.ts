import { groveApi } from "#lib/server/api.ts";
import { withRestInvocation } from "#lib/server/invocation.ts";
import { runGrove } from "#lib/server/runtime.ts";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) =>
	runGrove(withRestInvocation(groveApi.fetch(event.request)), event);
