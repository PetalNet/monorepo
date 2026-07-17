import { createServer } from "node:http";

import { loadEnv } from "../src/lib/server/domain/env";
import { setSharedConsoleServices } from "../src/lib/server/domain/shared-services";
import { buildServices } from "../src/lib/server/domain/substrate";
import { attachConsoleWebSockets } from "../src/lib/server/ws";
import { principalResolver } from "./principal";

const services = buildServices(loadEnv(), { migrate: false });
setSharedConsoleServices(services);

const [{ handler }, active] = await Promise.all([import("../build/handler.js"), services]);
const server = createServer(handler);
const detach = attachConsoleWebSockets(server, active, principalResolver(active));
const port = Number(process.env["PORT"] ?? "3000");
const host = process.env["HOST"] ?? "0.0.0.0";

server.listen(port, host, () =>
	process.stdout.write(`Lab Console listening on http://${host}:${String(port)}\n`),
);

const shutdown = () => {
	detach();
	server.close(() => void active.close().finally(() => process.exit(0)));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
