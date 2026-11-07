import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Listen on a free loopback port and return the server's base URL. */
export async function listenLocal(server: Server): Promise<string> {
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}
