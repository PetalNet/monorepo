import { createServer } from "node:http";

import { consoleApi } from "../src/lib/server/api/instance";
import { loadEnv } from "../src/lib/server/domain/env";
import { setSharedConsoleServices } from "../src/lib/server/domain/shared-services";
import { buildServices } from "../src/lib/server/domain/substrate";
import { attachConsoleWebSockets } from "../src/lib/server/ws";
import { nodeHeadersToWeb, principalResolver } from "./principal";

const services = buildServices(loadEnv(), { migrate: false });
setSharedConsoleServices(services);

const [{ handler }, active, api] = await Promise.all([
	import("../build/handler.js"),
	services,
	consoleApi(),
]);
const server = createServer(handler);
// Browser sessions resolve through the SvelteKit better-auth store; agent bearer tokens and dev
// principals fall through to the console API core's chain, so the bus accepts the same
// credentials as the REST surface.
const sessionResolver = principalResolver(active);
const detach = attachConsoleWebSockets(
	server,
	active,
	async (request) =>
		(await sessionResolver(request)) ??
		api.resolvePrincipal(nodeHeadersToWeb(request.headers), request.headers.host?.split(":")[0] ?? ""),
	{ counters: api.busCounters },
);
const port = Number(process.env["PORT"] ?? "3000");
const host = process.env["HOST"] ?? "0.0.0.0";

server.listen(port, host, () =>
	process.stdout.write(`Lab Console listening on http://${host}:${String(port)}\n`),
);

const shutdown = () => {
	detach();
	api.close();
	server.close(() => void active.close().finally(() => process.exit(0)));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
