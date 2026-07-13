import { dataMode, readBoxUpdateRaw, readBoxUpdates, readExecutors } from "$lib/api/client";
import type { BoxUpdateRaw } from "$lib/api/types";
import {
	assembleUpdates,
	liveEmptyUpdates,
	mockUpdates,
	type UpdatesData,
} from "$lib/data/updates";
import { captureCaughtFailure } from "$lib/glitchtip";

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
		const executors = await readExecutors(fetch).catch((error) => {
			captureCaughtFailure(error, { surface: "updates", endpoint: "/executors" });
			return null;
		});
		const liveHosts = (executors?.items ?? [])
			.filter((e) => e.kind === "box-agent" && e.liveness === "alive" && e.ref)
			.map((e) => e.ref as string);
		const rawResults = await Promise.allSettled(
			response.items.filter((row) => row.raw_ref).map((row) => readBoxUpdateRaw(row.box_id, fetch)),
		);
		const raw = rawResults.flatMap((result) => {
			if (result.status === "fulfilled") return [result.value];
			captureCaughtFailure(result.reason, {
				surface: "updates",
				endpoint: "/box-updates/:box_id/raw",
			});
			return [];
		});
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
	} catch (error) {
		captureCaughtFailure(error, { surface: "updates", endpoint: "/box-updates" });
		return { updates: liveEmptyUpdates(), raw: [] };
	}
};
