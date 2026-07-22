import { getRequestEvent, query } from "$app/server";
import type { WorkSettlementSnapshot } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { mockWorkSettlement } from "$lib/data/work-settlement";
import { error } from "@sveltejs/kit";

function isMock(): boolean {
	return publicConfig.dataMode === "mock";
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
	const base = publicConfig.consoleApiBase ?? `${event.url.origin}/api/v1`;
	const response = await event.fetch(`${base}/work/settlement`, {
		headers: forwardedHeaders(),
	});
	if (!response.ok)
		error(response.status, `Work settlement source returned ${String(response.status)}`);
	return (await response.json()) as WorkSettlementSnapshot;
});
