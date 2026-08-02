import { Effect } from "effect";

import { invokeOperation, type InvocationResult } from "./invoke.js";
import type { ApiOperation, LogCause } from "./operation.js";

interface RestConfig<R> {
	readonly basePath: string;
	readonly operations: readonly ApiOperation<R>[];
	readonly logCause: LogCause;
}

const json = (value: unknown, init?: ResponseInit): Response => Response.json(value, init);

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
	const expected = pattern.split("/").filter(Boolean);
	const actual = pathname.split("/").filter(Boolean);
	if (expected.length !== actual.length) return undefined;
	const params: Record<string, string> = {};
	for (const [index, segment] of expected.entries()) {
		const value = actual[index];
		if (value === undefined) return undefined;
		if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(value);
		else if (segment !== value) return undefined;
	}
	return params;
}

async function requestInput(request: Request, params: Record<string, string>): Promise<unknown> {
	const url = new URL(request.url);
	const query = Object.fromEntries(url.searchParams.entries());
	if (request.method === "GET" || request.method === "DELETE") return { ...query, ...params };
	const text = await request.text();
	if (text.length === 0) return { ...query, ...params };
	const body: unknown = JSON.parse(text);
	return typeof body === "object" && body !== null && !Array.isArray(body)
		? { ...body, ...query, ...params }
		: body;
}

const responseFor = (result: InvocationResult): Response =>
	result.kind === "success"
		? json(result.value)
		: json({ error: { code: result.code, message: result.message } }, { status: result.status });

export const createRestHandler =
	<R>(config: RestConfig<R>) =>
	(request: Request): Effect.Effect<Response, never, R> => {
		const url = new URL(request.url);
		const relativePath = url.pathname.startsWith(config.basePath)
			? url.pathname.slice(config.basePath.length) || "/"
			: url.pathname;
		const match = config.operations
			.filter((candidate) => candidate.method === request.method)
			.map((candidate) => ({
				operation: candidate,
				params: matchPath(candidate.path, relativePath),
			}))
			.find((candidate) => candidate.params !== undefined);
		if (!match) return Effect.succeed(json({ error: { code: "not_found" } }, { status: 404 }));
		const params = match.params;
		if (params === undefined) {
			return Effect.succeed(json({ error: { code: "not_found" } }, { status: 404 }));
		}
		return Effect.promise(() => requestInput(request, params).catch(() => undefined)).pipe(
			Effect.flatMap((input) =>
				input === undefined
					? Effect.succeed(
							json(
								{ error: { code: "invalid_json", message: "Expected a JSON body" } },
								{ status: 400 },
							),
						)
					: invokeOperation(match.operation, input, config.logCause).pipe(Effect.map(responseFor)),
			),
		);
	};
