import {
	dataMode,
	readAttention,
	readExecutors,
	readLeases,
	readTasks,
	runQuery,
} from "$lib/api/client";
import { readLiveLibrary } from "$lib/data/library";
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
	const [tasks, leases, executors, history, attention, library] = await Promise.all([
		readTasks(fetch).catch(() => null),
		readLeases(fetch).catch(() => null),
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
		readLiveLibrary(fetch).catch(() => null),
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
	const taskByTitle = new Map((tasks?.items ?? []).map((task) => [task.title.toLowerCase(), task]));
	const feed = (library?.items ?? [])
		.filter((item) => item.kind === "artifact")
		.map((item) => {
			const linkedTask = taskByTitle.get(item.title.toLowerCase());
			const taskMatch = /\/task\/(\d+)/.exec(item.body);
			const status = item.status.toLowerCase();
			return {
				id: item.id,
				taskId: linkedTask?.id ?? (taskMatch ? Number(taskMatch[1]) : 0),
				title: item.title,
				agent: item.creator,
				state: status.includes("fail")
					? ("failed" as const)
					: status.includes("build") || status === "draft"
						? ("building" as const)
						: ("shipped" as const),
				...(status.includes("fail") ? { step: "Library artifact" } : {}),
				updatedAt:
					linkedTask?.updated_at ??
					library?.provenance?.[item.id]?.txFrom ??
					new Date(0).toISOString(),
			};
		})
		.toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
		.slice(0, 12);
	return {
		tasks: tasks?.items ?? [],
		leases: leases?.items ?? [],
		// Wanted-board data is owned by wanted-board.remote.ts in live mode.
		wanted: [],
		events,
		feed,
		tasksAvailable: tasks !== null,
		wantedAvailable: true,
		feedAvailable: library?.connected === true,
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
