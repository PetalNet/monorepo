import { http } from "@petalnet/effect-sveltekit";

import { runGrove } from "#lib/server/runtime.ts";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) => runGrove(http(event.request), event);
