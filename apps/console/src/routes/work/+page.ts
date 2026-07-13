import {
	dataMode,
	readAttention,
	readCards,
	readExecutors,
	readLeases,
	readTasks,
	runQuery,
} from "$lib/api/client";
import {
	mockBuildFeed,
	mockLeases,
	mockTasks,
	mockWanted,
	mockWorkEvents,
	type WorkEvent,
} from "$lib/data/work";

import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (dataMode() === "mock")
		return {
			tasks: mockTasks,
			leases: mockLeases,
			wanted: mockWanted,
			events: mockWorkEvents,
			feed: mockBuildFeed,
			tasksAvailable: true,
			wantedAvailable: true,
			feedAvailable: true,
			trackerLive: true,
			dispatcherLive: true,
			attentionAvailable: true,
			ackedReviewTaskIds: [],
			snapshotAt: new Date().toISOString(),
			lanes: shell.me.lanes,
			tiers: shell.me.tiers,
			isMock: true,
		};
	const [tasks, leases, cards, executors, history, attention] = await Promise.all([
		readTasks(fetch).catch(() => null),
		readLeases(fetch).catch(() => null),
		readCards(fetch).catch(() => null),
		readExecutors(fetch).catch(() => null),
		runQuery(
			{
				schema_version: 1,
				mode: "structured",
				from: "events",
				select: [
					{ field: "seq" },
					{ field: "ts" },
					{ field: "type" },
					{ field: "task_id" },
					{ field: "source.agent" },
					{ field: "subject" },
				],
				where: { type: { op: "like", value: "task.%" } },
				order: [{ field: "seq", dir: "desc" }],
				limit: 200,
			},
			fetch,
		).catch(() => null),
		readAttention(fetch).catch(() => null),
	]);
	const events: WorkEvent[] = (history?.rows ?? []).flatMap((row) => {
		const taskId = Number(row[3]);
		if (!Number.isInteger(taskId)) return [];
		return [
			{
				id: String(row[0]),
				ts: String(row[1]),
				type: String(row[2]),
				taskId,
				agent: row[4] == null ? undefined : String(row[4]),
				detail: row[5] == null ? String(row[2]) : String(row[5]),
			},
		];
	});
	const alive = (kind: string) =>
		(executors?.items ?? []).some((item) => item.kind === kind && item.liveness === "alive");
	return {
		tasks: tasks?.items ?? [],
		leases: leases?.items ?? [],
		wanted: cards?.items ?? [],
		events,
		feed: [],
		tasksAvailable: tasks !== null,
		wantedAvailable: cards !== null,
		feedAvailable: false,
		attentionAvailable: attention !== null,
		ackedReviewTaskIds: (attention?.items ?? [])
			.filter((item) => item.grade === "review" && item.acked_by && item.task_id)
			.map((item) => item.task_id as number),
		trackerLive: alive("tracker"),
		dispatcherLive: alive("dispatcher"),
		snapshotAt: tasks?.freshness.observed_at ?? null,
		lanes: shell.me.lanes,
		tiers: shell.me.tiers,
		isMock: false,
	};
};
