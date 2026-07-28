import { runGrove } from "$lib/server/runtime";
import { sproutApi } from "$lib/server/sprouts/api";
import { Effect } from "effect";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = (event) =>
	runGrove(
		Effect.promise(() => event.request.json().catch(() => undefined)).pipe(
			Effect.flatMap((body) =>
				body === undefined
					? Effect.succeed(
							Response.json(
								{
									jsonrpc: "2.0",
									id: null,
									error: { code: -32700, message: "Parse error" },
								},
								{ status: 400 },
							),
						)
					: sproutApi.mcp(body),
			),
		),
		event,
	);
