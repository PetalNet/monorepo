import { consoleApi } from "$lib/server/api/instance";
import { buildOpenApiDocument } from "$lib/server/openapi";
import { Effect } from "effect";
import { Handler } from "svelte-effect-runtime/server";

import type { RequestHandler } from "./$types";

export const GET = Handler<RequestHandler>(() =>
	Effect.promise(() => consoleApi()).pipe(
		Effect.map((api) => Response.json(buildOpenApiDocument(api.routes))),
		Effect.catch(() =>
			Effect.succeed(Response.json({ error: "openapi unavailable" }, { status: 503 })),
		),
	),
);
