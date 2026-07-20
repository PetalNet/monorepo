import { getRequestEvent, query } from "$app/server";
const env = import.meta.env;
import { costComparisonRequestSchema } from "$lib/server/domain/cost/compare";
import { Schema } from "effect";

import type { CostComparisonResult } from "./cost";
import { mockCostComparison } from "./cost";

/** Server-only RPC boundary for pairwise cost comparison. Browser code never calls console-api. */
export const compareCost = query("unchecked", async (raw: unknown) => {
	const input = Schema.decodeUnknownSync(costComparisonRequestSchema)(raw);
	if (env.PUBLIC_CONSOLE_DATA_MODE === "mock")
		return mockCostComparison(input.dimension, input.left, input.right);

	const event = getRequestEvent();
	const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
	for (const name of ["authorization", "cookie"]) {
		const value = event.request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const base = env.PUBLIC_CONSOLE_API_BASE ?? `${event.url.origin}/api/v1`;
	const response = await event.fetch(`${base}/cost/compare`, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		throw new Error(body?.error?.message ?? `Cost comparison failed (${String(response.status)})`);
	}
	return (await response.json()) as CostComparisonResult;
});
