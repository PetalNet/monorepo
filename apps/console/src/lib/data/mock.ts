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
	RosterItem,
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

// A busy-but-fine board: evidence fresh, attention set non-empty, no P0 member.
// Drives the "Mostly fine. N things need you." greeting + the needs-you split.
export const attentionBusy: AttentionItem[] = [
	{
		schema_version: 1,
		id: "att_hopper_blocker",
		grade: "blocker",
		source: "task-card",
		subject: "hopper-3",
		summary: "hopper-3 asks: staging or prod DNS for the doorman test?",
		ts: iso(720_000),
		scope: "fleet",
		task_id: 731,
		// fix_ops carry server-pre-bound args exactly per ops.json (task.dispatch
		// requires `body`; recipient is the addressed handle).
		fix_ops: [
			{
				op: "task.dispatch",
				args: {
					recipient: "hopper-3",
					task_id: 731,
					body: "Use staging DNS for the doorman test.",
				},
			},
		],
		acked_by: null,
	},
	{
		schema_version: 1,
		id: "att_review_library",
		grade: "review",
		source: "tracker",
		subject: "library-backfill",
		summary: "Library backfill is review-ready. carson-2 wants your sign-off.",
		ts: iso(1_500_000),
		scope: "fleet",
		task_id: 718,
		// Review-ready lead action is "Open review" — a Work-surface navigation, not
		// a mutating op; it lands with the Work surface. No fix_op button here.
		fix_ops: [],
		acked_by: null,
	},
	{
		schema_version: 1,
		id: "att_artifact_cost",
		grade: "artifact",
		source: "feed",
		subject: "fleet-cost-report",
		summary: "Requested and ready: the fleet cost report you asked for.",
		ts: iso(180_000),
		scope: "user:parker",
		task_id: null,
		fix_ops: [{ op: "dashboard.pin", args: { dashboard_id: "d2" } }],
		acked_by: null,
	},
	{
		schema_version: 1,
		id: "att_review_held",
		grade: "review",
		source: "tracker",
		subject: "point-mobile-spec",
		summary: "Point mobile spec is review-ready.",
		ts: iso(2_400_000),
		scope: "fleet",
		task_id: 705,
		fix_ops: [],
		acked_by: "janet",
	},
];

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
		// fix_ops carry server-PRE-BOUND args (§5.3); the exact per-op arg schema
		// is ops.json (term.watch needs host/tmux_session/pane_id, not a handle).
		// A live crash is not the moment to mute the signal, so no signal.snooze.
		fix_ops: [
			{ op: "agent.restart", args: { handle: "carson-2" } },
			{ op: "term.watch", args: { host: ".14", tmux_session: "agents", pane_id: "%12" } },
		],
		acked_by: null,
		blast_radius: {
			host: ".14",
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

// The Agents surface reads /roster (a server-side join). One row per agent.
export const roster: RosterItem[] = [
	{
		handle: "hopper-3",
		host: ".15",
		status: "working",
		current_tool: "WebFetch",
		task_id: 731,
		task_title: "doorman enrollment test",
		heartbeat_state: "rate_limited",
		crash_count: 0,
		channel_lock_state: "held",
		autonomy: "ask",
		lane: "operator",
		light: "yellow",
		tokens_spent: 612_000,
		tier: "sonnet",
		lease_expires_at: new Date(now + 4 * 60_000).toISOString(),
		fence: 2,
		workers_active: 0,
		updated_at: iso(8_000),
		observed_at: iso(6_000),
		fleet_updated_at: iso(8_000),
		started_at: iso(2_700_000),
		registry_last_seen_epoch: epoch(8),
	},
	{
		handle: "janet",
		host: ".202",
		status: "working",
		current_tool: "Bash",
		task_id: 712,
		task_title: "console frontend",
		heartbeat_state: "running",
		crash_count: 0,
		channel_lock_state: "held",
		autonomy: "auto",
		lane: "admin",
		light: "green",
		tokens_spent: 380_000,
		tier: "opus",
		lease_expires_at: new Date(now + 22 * 60_000).toISOString(),
		fence: 1,
		workers_active: 2,
		updated_at: iso(6_000),
		observed_at: iso(5_000),
		fleet_updated_at: iso(6_000),
		started_at: iso(3_600_000),
		registry_last_seen_epoch: epoch(6),
	},
	{
		handle: "carson-2",
		host: ".14",
		status: "working",
		current_tool: "Edit",
		task_id: 718,
		task_title: "library backfill",
		heartbeat_state: "running",
		crash_count: 3,
		channel_lock_state: "held",
		autonomy: "auto",
		lane: "operator",
		light: "green",
		tokens_spent: 214_000,
		tier: "sonnet",
		lease_expires_at: new Date(now + 18 * 60_000).toISOString(),
		fence: 4,
		workers_active: 1,
		updated_at: iso(9_000),
		observed_at: iso(8_000),
		fleet_updated_at: iso(9_000),
		started_at: iso(5_400_000),
		registry_last_seen_epoch: epoch(9),
	},
	{
		handle: "point-fable",
		host: ".14",
		status: "idle",
		current_tool: null,
		task_id: null,
		task_title: null,
		heartbeat_state: "running",
		crash_count: 0,
		channel_lock_state: "released",
		autonomy: "auto",
		lane: "operator",
		light: "green",
		tokens_spent: 96_000,
		tier: "sonnet",
		lease_expires_at: null,
		fence: null,
		workers_active: 0,
		updated_at: iso(22_000),
		observed_at: iso(21_000),
		fleet_updated_at: iso(22_000),
		started_at: iso(7_200_000),
		registry_last_seen_epoch: epoch(22),
	},
	{
		// Registry stub: known to the capacity registry, no fleet/heartbeat row.
		// Rendered in Idle, never hidden.
		handle: "derek",
		host: "mc34",
		status: null,
		current_tool: null,
		task_id: null,
		task_title: null,
		heartbeat_state: null,
		crash_count: null,
		channel_lock_state: null,
		autonomy: "readonly",
		lane: "viewer",
		light: null,
		tokens_spent: null,
		tier: null,
		lease_expires_at: null,
		fence: null,
		workers_active: 0,
		updated_at: iso(240_000),
		observed_at: iso(239_000),
		fleet_updated_at: null,
		started_at: null,
		registry_last_seen_epoch: epoch(240),
	},
];

/** Fleet-wide governance summary for the FleetStrip (/task/716). */
export interface FleetSummary {
	tokensSpent: number;
	tokensGranted: number;
	mode: "parallel" | "sequential";
	modeReason: string | null;
	disciplineOffTask: number;
	disciplineNote: string | null;
}
export const fleetSummary: FleetSummary = {
	tokensSpent: 1_420_000,
	tokensGranted: 2_200_000,
	mode: "parallel",
	modeReason: null,
	disciplineOffTask: 0,
	disciplineNote: null,
};

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
