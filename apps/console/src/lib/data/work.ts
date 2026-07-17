import type { CardItem, LeaseItem, TaskItem } from "$lib/api/types";

const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
export interface WorkEvent {
	id: string;
	ts: string;
	type: string;
	taskId: number;
	agent?: string;
	detail: string;
}
export interface BuildFeedItem {
	id: string;
	taskId: number;
	title: string;
	agent: string;
	state: "shipped" | "building" | "failed";
	step?: string;
	attempt?: number;
	updatedAt: string;
}
const task = (
	item: Partial<TaskItem> & Pick<TaskItem, "id" | "title" | "status" | "priority">,
): TaskItem => ({
	kind: "task",
	created_at: iso(2 * 864e5),
	updated_at: iso(8 * 6e4),
	verification_status: "unverified",
	...item,
});
export const mockTasks: TaskItem[] = [
	task({
		id: 742,
		title: "Restore lake retention job",
		status: "todo",
		priority: 0,
		project_title: "console",
		suggested_agent: "carson-2",
		capability: "build",
		updated_at: iso(40 * 6e4),
	}),
	task({
		id: 731,
		title: "Doorman dashboard panel",
		status: "review",
		priority: 1,
		project_title: "network",
		assignee: "scout",
		claimed_by: "scout",
		lease_expires_at: iso(-12 * 6e4),
		acceptance_criteria:
			"Panel renders tunnel state from the bus\nBoth themes AAA measured\nHandshake counter verified against Jeff's Desk",
		handoff_context:
			"Edge status reads doorman heartbeats over the bus. Use the HouseTile tick pattern for the booth.",
		parallel_group: "edge-ui",
	}),
	task({
		id: 734,
		title: "Task drawer spec",
		status: "review",
		priority: 2,
		project_title: "console",
		assignee: "janet",
		claimed_by: "janet",
		lease_expires_at: iso(-22 * 6e4),
	}),
	task({
		id: 718,
		title: "Library backfill migration",
		status: "doing",
		priority: 1,
		project_title: "library",
		assignee: "carson-2",
		claimed_by: "carson-2",
		lease_expires_at: iso(-18 * 6e4),
		acceptance_criteria: "Backfill preserves item identity\nNo duplicate links",
		handoff_context: "Run the migration against the disposable copy first.",
	}),
	task({
		id: 736,
		title: "Update collector rollout",
		status: "doing",
		priority: 2,
		project_title: "hosts",
		assignee: "point-fable",
		claimed_by: "point-fable",
		lease_expires_at: iso(-4 * 6e4),
	}),
	task({
		id: 725,
		title: "Backfill library embeddings",
		status: "todo",
		priority: 1,
		project_title: "library",
		suggested_agent: "carson-2",
		capability: "research",
	}),
	task({
		id: 739,
		title: "Migrate mc34 containers",
		status: "blocked",
		priority: 1,
		project_title: "hosts",
		blocked_on: "waiting on maintenance window",
	}),
	task({
		id: 744,
		title: "Triage new console request",
		status: "inbox",
		priority: 2,
		project_title: "console",
		suggested_agent: "janet",
	}),
	task({
		id: 728,
		title: "Reap loop",
		status: "done",
		priority: 2,
		project_title: "work",
		verification_status: "verified",
		result_summary: "Lease reap now increments the fence once.",
		updated_at: iso(2 * 36e5),
	}),
	task({
		id: 727,
		title: "Snapshot dedupe",
		status: "done",
		priority: 2,
		project_title: "bus",
		verification_status: "verified",
		updated_at: iso(22 * 36e5),
	}),
	task({
		id: 726,
		title: "Normalize tracker timestamps",
		status: "done",
		priority: 2,
		project_title: "work",
		assignee: "janet",
		verification_status: "verified",
		result_summary: "Tracker timestamps now cross the read boundary as RFC 3339 UTC.",
		updated_at: iso(30 * 36e5),
	}),
];
export const mockLeases: LeaseItem[] = [
	{
		schema_version: 1,
		task_id: 731,
		worker: "scout",
		fence: 2,
		granted_at: iso(18 * 6e4),
		lease_expires_at: iso(-12 * 6e4),
		lease_seconds: 1800,
	},
	{
		schema_version: 1,
		task_id: 718,
		worker: "carson-2",
		fence: 4,
		granted_at: iso(12 * 6e4),
		lease_expires_at: iso(-18 * 6e4),
		lease_seconds: 1800,
	},
	{
		schema_version: 1,
		task_id: 736,
		worker: "point-fable",
		fence: 1,
		granted_at: iso(26 * 6e4),
		lease_expires_at: iso(-4 * 6e4),
		lease_seconds: 1800,
	},
];
export const mockWanted: CardItem[] = [
	{
		card_id: "w-1",
		task_id: 746,
		sender: "parker",
		sender_class: "principal",
		priority: 1,
		interrupt_policy: "defer",
		body: "Vega panel goldens for the feed charts",
		needs: ["charts"],
		state: "posted",
		fence: 0,
		reaps: 0,
		delivered: false,
		addressed: false,
		created_at_ms: now - 5 * 36e5,
		updated_at_ms: now - 5 * 36e5,
	},
	{
		card_id: "w-2",
		task_id: 747,
		sender: "janet",
		sender_class: "agent",
		priority: 2,
		interrupt_policy: "defer",
		body: "Port collector to .15",
		needs: ["hosts"],
		state: "posted",
		fence: 0,
		reaps: 0,
		delivered: false,
		addressed: false,
		created_at_ms: now - 72 * 6e4,
		updated_at_ms: now - 72 * 6e4,
	},
	{
		card_id: "w-3",
		task_id: 748,
		sender: "system:dispatcher",
		sender_class: "system",
		priority: 2,
		interrupt_policy: "defer",
		body: "Transcode gallery videos",
		needs: ["gpu"],
		state: "parked",
		fence: 1,
		reaps: 1,
		delivered: false,
		addressed: false,
		created_at_ms: now - 9 * 36e5,
		updated_at_ms: now - 2 * 36e5,
	},
	{
		card_id: "w-4",
		task_id: 749,
		sender: "system:dispatcher",
		sender_class: "system",
		priority: 1,
		interrupt_policy: "defer",
		body: "Nightly gallery export",
		needs: ["charts"],
		state: "dead",
		fence: 3,
		reaps: 3,
		delivered: false,
		addressed: false,
		created_at_ms: now - 20 * 36e5,
		updated_at_ms: now - 4 * 36e5,
	},
];
export const mockWorkEvents: WorkEvent[] = [
	{
		id: "e1",
		ts: iso(12 * 6e4),
		type: "task.claimed",
		taskId: 731,
		agent: "scout",
		detail: "claimed by scout · fence 2",
	},
	{
		id: "e2",
		ts: iso(7 * 6e4),
		type: "task.comment",
		taskId: 731,
		agent: "parker",
		detail: "check the handshake counter against Jeff's Desk",
	},
	{
		id: "e3",
		ts: iso(2 * 6e4),
		type: "task.transitioned",
		taskId: 731,
		agent: "scout",
		detail: "reported review · needs-you posted",
	},
];
export const mockBuildFeed: BuildFeedItem[] = [
	{
		id: "f1",
		taskId: 731,
		title: "Doorman dashboard panel",
		agent: "scout",
		state: "shipped",
		updatedAt: iso(4 * 6e4),
	},
	{
		id: "f2",
		taskId: 718,
		title: "Library item migration",
		agent: "carson-2",
		state: "building",
		attempt: 3,
		updatedAt: iso(9 * 6e4),
	},
	{
		id: "f3",
		taskId: 736,
		title: "Collector rollout",
		agent: "point-fable",
		state: "failed",
		step: "compile",
		attempt: 4,
		updatedAt: iso(14 * 6e4),
	},
];
