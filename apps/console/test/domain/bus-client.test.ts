import { connectBusClient, type BusWebSocket } from "@petalnet/console-bus-rpc";
import { describe, expect, it } from "vitest";

type Listener = (() => void) | ((event: { data: unknown }) => void);

class FakeSocket implements BusWebSocket {
	readonly sent: Record<string, unknown>[] = [];
	readonly listeners = new Map<string, Listener>();

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}
	close(): void {
		this.emit("close");
	}
	addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
		this.listeners.set(type, listener);
	}
	emit(type: "open" | "close"): void {
		(this.listeners.get(type) as (() => void) | undefined)?.();
	}
	message(frame: Record<string, unknown>): void {
		(this.listeners.get("message") as ((event: { data: unknown }) => void) | undefined)?.({
			data: JSON.stringify(frame),
		});
	}
}

describe("bus client reconnect", () => {
	it("resubscribes from the last event sequence after a disconnect", async () => {
		const sockets: FakeSocket[] = [];
		const client = connectBusClient({
			url: "ws://console.test",
			webSocket: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			subscriptions: () => [{ sub_id: "live", pattern: "test.**" }],
			reconnectDelayMs: 1,
			reconnectMaxDelayMs: 1,
		});
		sockets[0]?.emit("open");
		sockets[0]?.message({
			schema_version: 1,
			kind: "event",
			sub_id: "live",
			seq: 42,
			emission: {
				schema_version: 1,
				id: "event-42",
				type: "test.event",
				ts: new Date().toISOString(),
				source: { service: "test", host: null, agent: null },
				subject: "test",
				severity: "info",
				scope: "fleet",
			},
		});
		sockets[0]?.emit("close");
		await new Promise((resolve) => setTimeout(resolve, 10));
		sockets[1]?.emit("open");
		expect(sockets[1]?.sent[0]).toMatchObject({
			action: "subscribe",
			sub_id: "live",
			since: 42,
		});
		client.close();
	});
});
