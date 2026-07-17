import { me as mockMe } from "$lib/data/mock";
import { mockAudit, mockHeartbeats, type TermAuditView } from "$lib/data/terminal";
import {
	dataMode,
	readExecutors,
	readHeartbeats,
	readMe,
	readTerminalAccess,
	runQuery,
} from "$lib/rpc/browser";
import { error } from "@sveltejs/kit";

import { formatUnknown } from "#format";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => {
	if (dataMode() === "mock")
		return {
			denied: false,
			sessions: mockHeartbeats,
			audit: mockAudit,
			auditAvailable: true,
			auditWritable: true,
			lanes: mockMe.lanes,
			ptyLive: true,
			managerLive: true,
			adminName: mockMe.display_name ?? mockMe.id,
			grantName: mockMe.grant_name ?? mockMe.id,
			isMock: true,
		};

	let access: Awaited<ReturnType<typeof readTerminalAccess>>;
	try {
		access = await readTerminalAccess(fetch);
	} catch (cause) {
		if ((cause as { code?: string }).code === "term_denied")
			error(403, "Not with your key. Ask an admin. This attempt was logged.");
		error(503, "Terminal gate unavailable. No session details were disclosed.");
	}
	const me = await readMe(fetch).catch(() =>
		error(503, "Terminal identity unavailable. No session details were disclosed."),
	);

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
					{ field: "principal" },
					{ field: "host" },
					{ field: "tmux_session" },
					{ field: "pane_id" },
					{ field: "stream_id" },
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
			admin: row[3] == null ? "system" : formatUnknown(row[3]),
			action,
			host: row[4] == null ? "—" : formatUnknown(row[4]),
			tmuxSession: row[5] == null ? "—" : formatUnknown(row[5]),
			paneId: row[6] == null ? "—" : formatUnknown(row[6]),
			streamId: row[7] == null ? undefined : formatUnknown(row[7]),
		});
	}
	const alive = (kind: string) =>
		(executors?.items ?? []).some(
			(executor) => executor.kind === kind && executor.liveness === "alive",
		);
	return {
		denied: false,
		sessions: (heartbeats?.items ?? []).filter(
			(heartbeat) => heartbeat.tmux_session && heartbeat.pane_id,
		),
		audit: rows,
		auditAvailable: audit !== null,
		auditWritable: access.audit_writable,
		lanes: me.lanes,
		ptyLive: access.pty_live,
		managerLive: alive("manager"),
		adminName: me.display_name ?? me.id,
		grantName: me.grant_name ?? me.id,
		isMock: false,
	};
};
