import { filterByScopes, type TrackerReader, type TrackerRow } from "./tracker.ts";

const WORK_SETTLE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SettlingTask extends TrackerRow {
	settles_at: string;
}

export interface WorkSettlementSnapshot {
	schema_version: 1;
	observed_at: string;
	settle_window_s: 86_400;
	settled_this_week: number;
	invalid_timestamp_count: number;
	settling: SettlingTask[];
	history: SettlingTask[];
}

function timestamp(value: unknown): number | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Projects tracker-owned closed tasks into Work's 24h settle strip and Library history. This
 * changes no tracker state: Work and Library are two time-based lenses over one stable task id.
 */
function partitionWorkSettlement(
	rows: readonly TrackerRow[],
	now = new Date(),
): WorkSettlementSnapshot {
	const nowMs = now.getTime();
	const closed: SettlingTask[] = [];
	let invalidTimestampCount = 0;

	for (const row of rows) {
		if (row["status"] !== "done" && row["status"] !== "dropped") continue;
		const updatedAt = timestamp(row["updated_at"]);
		const createdAt = timestamp(row["created_at"]);
		if (updatedAt === null || createdAt === null) {
			invalidTimestampCount += 1;
			continue;
		}
		closed.push({
			...row,
			created_at: new Date(createdAt).toISOString(),
			updated_at: new Date(updatedAt).toISOString(),
			project_title: row["project_title"] ?? row["project_name"] ?? null,
			settles_at: new Date(updatedAt + WORK_SETTLE_WINDOW_MS).toISOString(),
		});
	}

	closed.sort(
		(left, right) =>
			Date.parse(String(right["updated_at"])) - Date.parse(String(left["updated_at"])),
	);
	const settling = closed.filter(
		(item) => item["status"] === "done" && Date.parse(item.settles_at) > nowMs,
	);
	const history = closed.filter(
		(item) => item["status"] === "dropped" || Date.parse(item.settles_at) <= nowMs,
	);
	const settledThisWeek = history.filter((item) => {
		if (item["status"] !== "done") return false;
		const settledAt = Date.parse(item.settles_at);
		return settledAt > nowMs - WEEK_MS && settledAt <= nowMs;
	}).length;

	return {
		schema_version: 1,
		observed_at: now.toISOString(),
		settle_window_s: 86_400,
		settled_this_week: settledThisWeek,
		invalid_timestamp_count: invalidTimestampCount,
		settling,
		history,
	};
}

export function readWorkSettlement(
	tracker: TrackerReader,
	scopes: readonly string[],
	now = new Date(),
): WorkSettlementSnapshot {
	return partitionWorkSettlement(filterByScopes(tracker.closedTasks(), scopes), now);
}
