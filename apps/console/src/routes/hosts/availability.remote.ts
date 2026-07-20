import { getRequestEvent, query } from "$app/server";
const env = import.meta.env;
import {
	validateContract,
	type AvailabilitySnapshot,
	type ExecutorItem,
	type ReadEnvelope,
} from "$lib/api/types";
import { mockAvailability } from "$lib/data/availability";
import { error } from "@sveltejs/kit";

export interface AvailabilityRemoteResult {
	readonly snapshot: AvailabilitySnapshot;
	readonly probe_runner_live: boolean;
}

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? `${getRequestEvent().url.origin}/api/v1`;
}

function forwardedHeaders(): Headers {
	const incoming = getRequestEvent().request.headers;
	const headers = new Headers({ accept: "application/json", origin: getRequestEvent().url.origin });
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

async function readJson<T>(path: string): Promise<T> {
	const response = await getRequestEvent().fetch(`${apiBase()}${path}`, {
		headers: forwardedHeaders(),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		error(
			response.status,
			body?.error?.message ?? `Console API returned ${String(response.status)}`,
		);
	}
	return (await response.json()) as T;
}

/** Server-side RPC for Hosts availability. Browser code never calls console-api directly. */
export const getAvailability = query(async (): Promise<AvailabilityRemoteResult> => {
	if (env.PUBLIC_CONSOLE_DATA_MODE !== "live")
		return { snapshot: mockAvailability(), probe_runner_live: true };
	const [snapshot, executors] = await Promise.all([
		readJson<AvailabilitySnapshot>("/availability?window=30d"),
		readJson<ReadEnvelope<ExecutorItem>>("/executors"),
	]);
	const validation = validateContract("AvailabilitySnapshot", snapshot);
	if (!validation.valid) error(502, "Availability response failed its contract");
	return {
		snapshot,
		probe_runner_live: executors.items.some(
			(executor) => executor.kind === "probe-runner" && executor.liveness === "alive",
		),
	};
});
