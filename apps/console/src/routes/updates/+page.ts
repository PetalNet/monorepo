import { dataMode, readBoxUpdateRaw, readBoxUpdates, readExecutors } from "$lib/api/client";
import type { BoxUpdateRaw } from "$lib/api/types";
import {
	assembleUpdates,
	liveEmptyUpdates,
	mockUpdates,
	type UpdatesData,
} from "$lib/data/updates";

import type { PageLoad } from "./$types";

/**
 * Updates & Security data (09-updates §6): the Reboots board over /box-updates. Mock-default; live
 * reads /box-updates once wired against the running console-api.
 */
export const load: PageLoad = async ({
	fetch,
	parent,
}): Promise<{ updates: UpdatesData; raw: BoxUpdateRaw[] }> => {
	const shell = await parent();
	if (dataMode() === "mock") return { updates: mockUpdates(shell.me.lanes), raw: [] };
	try {
		const response = await readBoxUpdates(fetch);
		const executors = await readExecutors(fetch).catch(() => null);
		const liveHosts = (executors?.items ?? [])
			.filter((e) => e.kind === "box-agent" && e.liveness === "alive" && e.ref)
			.map((e) => e.ref as string);
		const raw = (
			await Promise.allSettled(
				response.items
					.filter((row) => row.raw_ref)
					.map((row) => readBoxUpdateRaw(row.box_id, fetch)),
			)
		).flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		return {
			updates: assembleUpdates(response.items, {
				now: Date.now(),
				windowS: response.freshness.window_s,
				freshnessSource: response.freshness.source,
				freshnessObservedAt: response.freshness.observed_at,
				truncated: response.truncated === true || response.next_cursor !== null,
				executorLiveHosts: liveHosts,
				lanes: shell.me.lanes,
			}),
			raw,
		};
	} catch {
		return { updates: liveEmptyUpdates(), raw: [] };
	}
};
