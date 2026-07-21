import { getRequestEvent, query } from "$app/server";
const env = import.meta.env;
import type { WorkSettlementSnapshot } from "$lib/api/types";
import { mockWorkSettlement } from "$lib/data/work-settlement";
import { error } from "@sveltejs/kit";

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE === "mock";
}

function forwardedHeaders(): Headers {
	const incoming = getRequestEvent().request.headers;
	const headers = new Headers({ accept: "application/json" });
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

/** One caller-scoped RPC powers Work's settle strip and Library's task-history projection. */
export const getWorkSettlement = query(async (): Promise<WorkSettlementSnapshot> => {
	if (isMock()) return mockWorkSettlement();
	const event = getRequestEvent();
	const base = env.PUBLIC_CONSOLE_API_BASE ?? `${event.url.origin}/api/v1`;
	const response = await event.fetch(`${base}/work/settlement`, {
		headers: forwardedHeaders(),
	});
	if (!response.ok)
		error(response.status, `Work settlement source returned ${String(response.status)}`);
	return (await response.json()) as WorkSettlementSnapshot;
});
