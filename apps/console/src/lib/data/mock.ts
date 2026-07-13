/**
 * Contract-shaped fixtures for `PUBLIC_CONSOLE_DATA_MODE=mock`. Every object matches the
 * console-api schema it stands in for, so the same components drive mock and live data (no facade).
 * The scene mirrors the shell mock (00-shell-mock.html): Parker's cockpit,
 * janet/carson-2/point-fable, hosts .202/.14/.15/mc34. Timestamps are relative to load time so
 * freshness derivations read fresh.
 */
import type {
	AttentionItem,
	BoxUpdateItem,
	CommsEvent,
	FleetItem,
	Me,
	RegistryItem,
} from "$lib/api/types";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const epoch = (sAgo: number) => Math.floor((now - sAgo * 1000) / 1000);

export const me: Me = {
	schema_version: 1,
	kind: "human",
	id: "parker",
	tiers: ["owner"],
	lanes: ["viewer", "editor", "operator", "admin", "term_admin"],
	scopes: ["user:parker", "fleet"],
	zookie: "zk_mock_0",
	display_name: "Parker",
	grant_name: "parker",
};

export const fleet: FleetItem[] = [
	{
		handle: "janet",
		host: ".202",
		status: "working",
		current_tool: "Bash",
		task_id: 712,
		session_id: "s-janet",
		started_at: iso(3_600_000),
		updated_at: iso(4_000),
		observed_at: iso(3_000),
	},
	{
		handle: "carson-2",
		host: ".14",
		status: "working",
		current_tool: "Edit",
		task_id: 718,
		session_id: "s-carson2",
		started_at: iso(5_400_000),
		updated_at: iso(9_000),
		observed_at: iso(8_000),
	},
	{
		handle: "point-fable",
		host: ".14",
		status: "idle",
		current_tool: null,
		task_id: null,
		session_id: "s-pf",
		started_at: iso(7_200_000),
		updated_at: iso(22_000),
		observed_at: iso(21_000),
	},
];

// Crash variant: carson-2 down, drives the facade crack scene.
export const fleetCracked: FleetItem[] = fleet.map((f) =>
	f.handle === "carson-2"
		? {
				...f,
				status: "idle",
				current_tool: null,
				updated_at: iso(310_000),
				observed_at: iso(309_000),
			}
		: f,
);

export const registry: RegistryItem[] = [
	{
		handle: "janet",
		provides: ["ops", "research"],
		free_slots: 1,
		host: ".202",
		last_seen_epoch: epoch(6),
	},
	{
		handle: "carson-2",
		provides: ["build"],
		free_slots: 0,
		host: ".14",
		last_seen_epoch: epoch(9),
	},
	{
		handle: "point-fable",
		provides: ["build", "mobile"],
		free_slots: 2,
		host: ".14",
		last_seen_epoch: epoch(22),
	},
];

export const boxUpdates: BoxUpdateItem[] = [
	{
		box_id: "a1:202",
		hostname: ".202",
		os_family: "linux",
		source_tool: "action1",
		agent_vs_agentless: "agent",
		pending_updates_count: 0,
		security_critical_count: 0,
		vuln_count: 0,
		reboot_required: 0,
		status: "up_to_date",
		updated_at: iso(120_000),
	},
	{
		box_id: "a1:14",
		hostname: ".14",
		os_family: "linux",
		source_tool: "action1",
		agent_vs_agentless: "agent",
		pending_updates_count: 4,
		security_critical_count: 0,
		vuln_count: 0,
		reboot_required: 0,
		status: "updates_pending",
		updated_at: iso(120_000),
	},
	{
		box_id: "a1:15",
		hostname: ".15",
		os_family: "linux",
		source_tool: "action1",
		agent_vs_agentless: "agent",
		pending_updates_count: 7,
		security_critical_count: 1,
		vuln_count: 2,
		reboot_required: 1,
		status: "updates_overdue",
		updated_at: iso(120_000),
	},
	{
		box_id: "truenas:mc34",
		hostname: "mc34",
		os_family: "truenas",
		source_tool: "truenas-ws",
		agent_vs_agentless: "agentless",
		pending_updates_count: null,
		security_critical_count: null,
		vuln_count: null,
		reboot_required: null,
		status: "error_collecting",
		updated_at: iso(600_000),
	},
];

// Hosts for the fleet rail (derived from registry + box updates in real life;
// the shell rail needs a light host list — worker counts come from registry).
export interface RailHost {
	host: string;
	workersUp: number;
	dark: boolean;
}
export const railHosts: RailHost[] = [
	{ host: ".202", workersUp: 1, dark: false },
	{ host: ".14", workersUp: 2, dark: false },
	{ host: ".15", workersUp: 0, dark: false },
	{ host: "mc34", workersUp: 0, dark: true },
];

export const attentionEmpty: AttentionItem[] = [];

export const attentionCracked: AttentionItem[] = [
	{
		schema_version: 1,
		id: "att_carson2_crash",
		grade: "p0",
		source: "heartbeat",
		subject: "carson-2",
		summary: "carson-2 crashed at 14:02. Everything is not fine.",
		ts: iso(300_000),
		scope: "fleet",
		task_id: 718,
		incident_key: "heartbeat:carson-2",
		fix_ops: [
			{ op: "agent.restart", args: { handle: "carson-2" } },
			{ op: "term.watch", args: { handle: "carson-2" } },
			{ op: "signal.snooze", args: { subject: "carson-2", duration: "1h" } },
		],
		acked_by: null,
		blast_radius: {
			hosts: 1,
			residents: 2,
			leases_expiring_30m: 1,
			detail: "On .14 with 2 other residents",
		},
	},
];

export const comms: CommsEvent[] = [
	{
		id: "c1",
		method: "comms.card",
		sender: "janet",
		recipient: "carson-2",
		task_id: 718,
		ts: iso(120_000),
		card_id: "card-1",
	},
	{ id: "c2", method: "comms.rpc", sender: "dispatcher", recipient: "fleet", ts: iso(2_000) },
];

export interface SavedDashboard {
	id: string;
	name: string;
	sub: string;
}
export const savedDashboards: SavedDashboard[] = [
	{ id: "d1", name: "Morning sweep", sub: "9 panels · home" },
	{ id: "d2", name: "Token burn, fleet", sub: "4 panels · live" },
	{ id: "d3", name: "Sleep vs deploys", sub: "investigation · 12 nodes" },
];
