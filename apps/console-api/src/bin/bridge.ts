// console-api-bridge — the co-located .14-local bridge (N1b-3). Builds the service assembly and
// runs the bridge poll loop, ingesting local as-built sources into the lake. Configure sources via
// env (SYSTEM_OUTBOX_DIR). Remote boxes run their own per-box bridge (future Rust console-bridge).

import { buildServices } from "../app.ts";
import { Bridge } from "../bridge/index.ts";
import { loadEnv } from "../env.ts";

const POLL_MS = Number(process.env["BRIDGE_POLL_MS"] ?? "5000");

async function main(): Promise<void> {
	const env = loadEnv();
	const services = await buildServices(env, { migrate: false });
	const bridge = new Bridge(
		services.db.writer,
		(subject, emission, bytes) => services.emit(subject, emission, bytes),
		{ systemOutboxDir: process.env["SYSTEM_OUTBOX_DIR"] ?? undefined },
	);
	bridge.start(POLL_MS);
	process.stdout.write(`console-api-bridge: polling every ${String(POLL_MS)}ms\n`);
	// keep alive; the interval is unref'd, so hold the process open explicitly.
	await new Promise(() => {});
}

await main();
