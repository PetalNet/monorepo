// Regression coverage for the svelte-ws crossws bridge (packages/svelte-ws/src/runtime.ts): a
// typed bus client sends `subscribe` on `open`, while the console's handleWebsocket awaits its
// services before registering the message listener — frames landing in that window must be
// buffered and flushed in order, and a socket that closes inside the window must still run the
// cleanup its late-registered close listener carries.
import { createServer, type Server } from "node:http";

import type { HandleWebsocket } from "@petalnet/svelte-ws";
import { createWebsocketDispatcher } from "@petalnet/svelte-ws/runtime";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];

async function startDispatcher(handler: HandleWebsocket): Promise<string> {
	const dispatcher = createWebsocketDispatcher(() => Promise.resolve(handler));
	const server = createServer();
	server.on("upgrade", (request, socket, head) => {
		void dispatcher.handleUpgrade(request, socket, head);
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("dispatcher server did not bind");
	return `ws://127.0.0.1:${String(address.port)}`;
}

function connect(url: string): Promise<WebSocket> {
	const client = new WebSocket(url);
	return new Promise((resolve, reject) => {
		client.addEventListener("open", () => resolve(client), { once: true });
		client.addEventListener("error", () => reject(new Error("client failed to connect")), {
			once: true,
		});
	});
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
	const open = servers.splice(0);
	await Promise.all(
		open.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

describe("svelte-ws runtime cold start", () => {
	it("delivers and acks frames sent before the async handler registers its listener, in order", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const received: string[] = [];
		let allDelivered!: () => void;
		const delivered = new Promise<void>((resolve) => {
			allDelivered = resolve;
		});
		const handler: HandleWebsocket = async ({ socket }) => {
			await gate; // stands in for ws.ts awaiting consoleApi()/consoleServices()
			socket.on("message", (data) => {
				const text = Buffer.from(data).toString();
				received.push(text);
				socket.send(`ack:${text}`);
				if (received.length === 3) allDelivered();
			});
		};
		const url = await startDispatcher(handler);
		const client = await connect(url);
		const acks: string[] = [];
		client.addEventListener("message", (event) => {
			acks.push(String(event.data));
		});
		// Both frames land while the handler is still awaiting its setup — the pre-fix runtime
		// dropped them silently because no message listener existed yet.
		client.send("subscribe-1");
		client.send("subscribe-2");
		await settle(150);
		expect(received).toEqual([]);
		release();
		client.send("post-setup");
		await delivered;
		expect(received).toEqual(["subscribe-1", "subscribe-2", "post-setup"]);
		await settle(150);
		expect(acks).toEqual(["ack:subscribe-1", "ack:subscribe-2", "ack:post-setup"]);
		client.close();
	});

	it("fires close listeners registered after the peer already closed, so cleanup always runs", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let report!: (outcome: { closeFired: boolean; openAfterClose: boolean }) => void;
		const outcome = new Promise<{ closeFired: boolean; openAfterClose: boolean }>((resolve) => {
			report = resolve;
		});
		const handler: HandleWebsocket = async ({ socket }) => {
			await gate; // the socket closes while this await is pending
			let closeFired = false;
			socket.on("close", () => {
				closeFired = true;
			});
			report({ closeFired, openAfterClose: socket.isOpen() });
		};
		const url = await startDispatcher(handler);
		const client = await connect(url);
		client.close();
		await settle(200); // let the server observe the close before the handler resumes
		release();
		await expect(outcome).resolves.toEqual({ closeFired: true, openAfterClose: false });
	});
});
