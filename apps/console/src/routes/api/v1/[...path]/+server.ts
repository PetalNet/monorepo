import type { OpResult, StructuredQuery } from "$lib/api/types";
import { executeNamedOp, runStructuredQuery, type ReadPlane } from "$lib/operations.remote";
import { readPlane } from "$lib/rpc/read-plane";
import { handleAssistantMcp } from "$lib/server/domain/assistant/tools";
import { currentPrincipal } from "$lib/server/domain/principal";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect } from "effect";
import { Handler } from "svelte-effect-runtime/server";

import type { RequestHandler } from "./$types";

const planes: Record<string, ReadPlane> = {
	attention: "attention",
	"box-updates": "box-updates",
	cards: "cards",
	catalog: "catalog",
	dashboards: "dashboards",
	"edge/sessions": "edge-sessions",
	executors: "executors",
	governance: "governance",
	health: "health",
	heartbeats: "heartbeats",
	leases: "leases",
	me: "me",
	registry: "registry",
	roster: "roster",
	subscriptions: "subscriptions",
	tasks: "tasks",
	workers: "workers",
};

export const GET = Handler<RequestHandler>(({ params }) =>
	Effect.gen(function* () {
		const plane = planes[params.path];

		return Response.json(yield* Effect.orDie(readPlane(plane)));
	}),
);

export const POST = Handler<RequestHandler>(({ params, request }) =>
	Effect.gen(function* () {
		const body: unknown = yield* Effect.tryPromise(() => request.json() as Promise<unknown>);
		if (params.path === "query")
			return Response.json(yield* Effect.orDie(runStructuredQuery(body as StructuredQuery)));
		if (params.path === "op") {
			const call = body as { op: string; args: Record<string, unknown>; dry_run?: boolean };
			const result: OpResult = yield* Effect.orDie(executeNamedOp(call));
			return Response.json(result);
		}
		if (params.path === "mcp") {
			const domain = yield* ConsoleDomain;
			const services = yield* domain.services;
			const principal = yield* currentPrincipal;
			return Response.json(
				yield* Effect.tryPromise(() => handleAssistantMcp(services, principal, body)),
			);
		}
		return new Response("Not found", { status: 404 });
	}).pipe(Effect.orDie),
);
