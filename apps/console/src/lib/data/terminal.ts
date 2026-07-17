import type { HeartbeatItem } from "$lib/api/types";

const now = Date.now(),
	epoch = (ago: number) => Math.floor((now - ago) / 1000),
	iso = (ago: number) => new Date(now - ago).toISOString();
export interface TermAuditView {
	id: string;
	ts: string;
	admin: string;
	action: "watch" | "attach" | "input" | "detach" | "denied";
	host: string;
	tmuxSession: string;
	paneId: string;
	streamId?: string;
	inputRef?: string;
	client?: string;
}
export const mockHeartbeats: HeartbeatItem[] = [
	{
		schema_version: 2,
		version: "2.4.1",
		handle: "carson-2",
		pid: 4120,
		state: "running",
		session_id: "claude-carson",
		tmux_session: "agent-claude",
		pane_id: "%12",
		io_ok: true,
		crash_count: 0,
		started_at_epoch: epoch(2 * 864e5),
		last_sync_ok_epoch: epoch(4e3),
		updated_at_epoch: epoch(4e3),
		host: ".14",
		observed_at: iso(4e3),
	},
	{
		schema_version: 2,
		version: "2.4.1",
		handle: "janet",
		pid: 2940,
		state: "running",
		session_id: "claude-janet",
		tmux_session: "agent-janet",
		pane_id: "%4",
		io_ok: true,
		crash_count: 0,
		started_at_epoch: epoch(6 * 864e5),
		last_sync_ok_epoch: epoch(5e3),
		updated_at_epoch: epoch(5e3),
		host: ".202",
		observed_at: iso(5e3),
	},
];
export const mockAudit: TermAuditView[] = [
	{
		id: "ta-1",
		ts: iso(4 * 6e4),
		admin: "parker",
		action: "attach",
		host: ".14",
		tmuxSession: "agent-claude",
		paneId: "%12",
		streamId: "stream-44",
		client: "console/web",
	},
	{
		id: "ta-2",
		ts: iso(8 * 6e4),
		admin: "parker",
		action: "watch",
		host: ".202",
		tmuxSession: "agent-janet",
		paneId: "%4",
		streamId: "stream-43",
		client: "console/web",
	},
	{
		id: "ta-3",
		ts: iso(12 * 6e4),
		admin: "codex",
		action: "denied",
		host: ".14",
		tmuxSession: "agent-claude",
		paneId: "%12",
		client: "api",
	},
];
export const mockPtyLines = [
	"Last login: Sun Jul 13 01:12:04 on pts/4",
	"parker@mc14:~$ tmux display-message -p '#S:#I.#P'",
	"agent-claude:0.0",
	"parker@mc14:~$ ",
];
