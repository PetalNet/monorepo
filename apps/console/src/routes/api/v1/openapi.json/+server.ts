import { openApiDocument } from "$lib/server/openapi";
import { Effect } from "effect";
import { Handler } from "svelte-effect-runtime/server";

import type { RequestHandler } from "./$types";

export const GET = Handler<RequestHandler>(() => Effect.succeed(Response.json(openApiDocument)));
