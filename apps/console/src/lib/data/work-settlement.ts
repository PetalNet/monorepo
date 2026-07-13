import type { WorkSettlementSnapshot } from "$lib/api/types";
import type { LibraryItemView } from "$lib/data/library";
import { mockTasks } from "$lib/data/work";

export type SettlingTask = WorkSettlementSnapshot["settling"][number];

const WINDOW_MS = 24 * 60 * 60 * 1_000;

export function mockWorkSettlement(now = new Date()): WorkSettlementSnapshot {
	const closed = mockTasks
		.filter((task) => task.status === "done" || task.status === "dropped")
		.map((task) => ({
			...task,
			settles_at: new Date(Date.parse(task.updated_at) + WINDOW_MS).toISOString(),
		}))
		.toSorted((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
	const nowMs = now.getTime();
	const history = closed.filter(
		(task) => task.status === "dropped" || Date.parse(task.settles_at) <= nowMs,
	);
	return {
		schema_version: 1,
		observed_at: now.toISOString(),
		settle_window_s: 86_400,
		settled_this_week: history.filter((task) => {
			const settledAt = Date.parse(task.settles_at);
			return task.status === "done" && settledAt > nowMs - 7 * WINDOW_MS && settledAt <= nowMs;
		}).length,
		invalid_timestamp_count: 0,
		settling: closed.filter(
			(task) => task.status === "done" && Date.parse(task.settles_at) > nowMs,
		),
		history,
	};
}

function relativeTime(value: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
	if (minutes < 60) return `${String(minutes)}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
}

export function settledTaskLibraryItem(task: SettlingTask): LibraryItemView {
	const project = task.project_title ?? "unfiled";
	const creator = task.claimed_by ?? task.assignee ?? task.created_by ?? task.owner ?? "unknown";
	return {
		id: `task:${String(task.id)}`,
		title: task.title,
		kind: "task",
		project,
		scope:
			task.visibility === "private" && task.owner
				? `user:${task.owner}`
				: project === "unfiled"
					? "fleet"
					: `project:${project}`,
		status: task.status,
		version: 1,
		updated: relativeTime(task.updated_at),
		creator,
		body:
			task.result_summary ??
			task.close_reason ??
			task.body ??
			(task.status === "dropped" ? "Closed without completion." : "Completed tracker task."),
	};
}
