// console-api-bridge — the co-located .14-local bridge (N1b-3). Builds the service assembly and
// runs the bridge poll loop, ingesting local as-built sources into the lake. Configure sources via
// env (SYSTEM_OUTBOX_DIR). Remote boxes run their own per-box bridge (future Rust console-bridge).

import {
	Bridge,
	DispatcherSqliteAdapter,
	FleetSnapshotAdapter,
	JsonlSpoolAdapter,
	ManagerHeartbeatAdapter,
} from "../src/lib/server/domain/bridge/index.ts";
import { loadEnv } from "../src/lib/server/domain/env.ts";
import { buildServices } from "../src/lib/server/domain/substrate.ts";

// Clamp to a sane finite interval: an unset/NaN/zero/negative value must not become a hot loop, and
// an absurdly large one shouldn't silently wedge the poller.
function pollMs(raw: string | undefined): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 250) return 5000;
	return Math.min(n, 3_600_000);
}

const POLL_MS = pollMs(process.env["BRIDGE_POLL_MS"]);

async function main(): Promise<void> {
	const env = loadEnv();
	const services = await buildServices(env, { migrate: false });
	const adapters = [];
	if (process.env["FLEET_SNAPSHOT_DIR"])
		adapters.push(new FleetSnapshotAdapter(process.env["FLEET_SNAPSHOT_DIR"]));
	if (process.env["MANAGER_HEARTBEAT_DIR"])
		adapters.push(new ManagerHeartbeatAdapter(process.env["MANAGER_HEARTBEAT_DIR"]));
	if (process.env["DISPATCHER_DB_PATH"])
		adapters.push(new DispatcherSqliteAdapter(process.env["DISPATCHER_DB_PATH"]));
	if (process.env["CONTROL_PLANE_OUTBOX_DIR"])
		adapters.push(
			new JsonlSpoolAdapter(
				"control-plane",
				"bridge:control-plane",
				"control-plane",
				process.env["CONTROL_PLANE_OUTBOX_DIR"],
			),
		);
	if (process.env["BOX_AGENT_OUTBOX_DIR"])
		adapters.push(
			new JsonlSpoolAdapter(
				"box-agent",
				"bridge:box-agent",
				"box-agent",
				process.env["BOX_AGENT_OUTBOX_DIR"],
			),
		);
	if (process.env["DOORMAN_OUTBOX_DIR"])
		adapters.push(
			new JsonlSpoolAdapter(
				"doorman",
				"bridge:doorman",
				"doorman",
				process.env["DOORMAN_OUTBOX_DIR"],
			),
		);
	const bridge = new Bridge(
		services.db.writer,
		(subject, emission, bytes) => services.emit(subject, emission, bytes),
		{ systemOutboxDir: process.env["SYSTEM_OUTBOX_DIR"] ?? undefined, adapters },
	);
	bridge.start(POLL_MS);
	process.stdout.write(`console-api-bridge: polling every ${String(POLL_MS)}ms\n`);
	// keep alive; the interval is unref'd, so hold the process open explicitly.
	await new Promise(() => {});
}

await main();
