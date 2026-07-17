import { getRequestEvent, query } from "$app/server";
const env = import.meta.env;

import type { CostComparisonRequest, CostComparisonResult } from "./cost";
import { mockCostComparison } from "./cost";

export type CompareCostInput = CostComparisonRequest;

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validTimestamp(value: string): boolean {
	return RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

function validTimezone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}

function valid(input: CompareCostInput): boolean {
	return (
		input.schema_version === 1 &&
		["agent", "model", "project"].includes(input.dimension) &&
		input.left.length > 0 &&
		input.left.length <= 256 &&
		input.right.length > 0 &&
		input.right.length <= 256 &&
		input.left !== input.right &&
		validTimestamp(input.from) &&
		validTimestamp(input.to) &&
		input.timezone.length <= 64 &&
		validTimezone(input.timezone)
	);
}

/** Server-only RPC boundary for pairwise cost comparison. Browser code never calls console-api. */
export const compareCost = query("unchecked", async (input: CompareCostInput) => {
	if (!valid(input)) throw new Error("Invalid cost comparison");
	if (env.PUBLIC_CONSOLE_DATA_MODE !== "live")
		return mockCostComparison(input.dimension, input.left, input.right);

	const event = getRequestEvent();
	const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
	for (const name of ["authorization", "cookie"]) {
		const value = event.request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const base = env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
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
