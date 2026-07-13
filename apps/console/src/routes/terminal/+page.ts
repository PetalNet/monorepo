import { dataMode, readExecutors, readHeartbeats, runQuery } from "$lib/api/client";
import { mockAudit, mockHeartbeats, type TermAuditView } from "$lib/data/terminal";

import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (!shell.me.lanes.includes("term_admin"))
		return {
			denied: true,
			sessions: [],
			audit: [],
			auditAvailable: false,
			auditWritable: false,
			lanes: shell.me.lanes,
			ptyLive: false,
			managerLive: false,
			adminName: shell.me.display_name ?? shell.me.id,
			grantName: shell.me.grant_name ?? shell.me.id,
			isMock: dataMode() === "mock",
		};
	if (dataMode() === "mock")
		return {
			denied: false,
			sessions: mockHeartbeats,
			audit: mockAudit,
			auditAvailable: true,
			auditWritable: true,
			lanes: shell.me.lanes,
			ptyLive: true,
			managerLive: true,
			adminName: shell.me.display_name ?? shell.me.id,
			grantName: shell.me.grant_name ?? shell.me.id,
			isMock: true,
		};
	const [heartbeats, executors, audit] = await Promise.all([
		readHeartbeats(fetch).catch(() => null),
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
					{ field: "source.agent" },
					{ field: "source.host" },
					{ field: "subject" },
				],
				where: { type: { op: "like", value: "term.%" } },
				order: [{ field: "seq", dir: "desc" }],
				limit: 100,
			},
			fetch,
		).catch(() => null),
	]);
	const actions = new Set<TermAuditView["action"]>([
		"watch",
		"attach",
		"input",
		"detach",
		"denied",
	]);
	const rows: TermAuditView[] = [];
	for (const row of audit?.rows ?? []) {
		const action = String(row[2]).replace(/^term\./, "") as TermAuditView["action"];
		if (!actions.has(action)) continue;
		rows.push({
			id: String(row[0]),
			ts: String(row[1]),
			admin: row[3] == null ? "system" : String(row[3]),
			action,
			host: row[4] == null ? "—" : String(row[4]),
			tmuxSession: row[5] == null ? "—" : String(row[5]),
			paneId: "—",
		});
	}
	const alive = (kind: string) =>
		(executors?.items ?? []).some((e) => e.kind === kind && e.liveness === "alive");
	return {
		denied: false,
		sessions: (heartbeats?.items ?? []).filter((h) => h.tmux_session && h.pane_id),
		audit: rows,
		auditAvailable: audit !== null,
		// A successful history query is not proof that the append path is writable.
		// The spec's audit.ping op is absent from the normative catalog (BLOCKERS.md).
		auditWritable: false,
		lanes: shell.me.lanes,
		// ops.json names `pty`, but the normative executor schema does not permit it.
		ptyLive: false,
		managerLive: alive("manager"),
		adminName: shell.me.display_name ?? shell.me.id,
		grantName: shell.me.grant_name ?? shell.me.id,
		isMock: false,
	};
};
