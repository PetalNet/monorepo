import { Effect } from "effect";

import { requireAuthenticatedUser } from "../authorization";
import { sproutApi } from "./api";

/** Authenticate before JSON-RPC dispatch so missing identity is an HTTP 401, not an MCP 200 error. */
export const handleMcpRequest = (request: Request) =>
	requireAuthenticatedUser.pipe(
		Effect.andThen(
			Effect.promise(() => request.json().catch(() => undefined) as Promise<unknown>).pipe(
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
						: sproutApi.mcp(body as Parameters<typeof sproutApi.mcp>[0]),
				),
			),
		),
	);
