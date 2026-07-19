import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
	connectBusClient,
	type BusServerFrame,
	type BusWebSocket,
} from "@petalnet/console-bus-rpc";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Broker } from "../../src/lib/server/domain/bus/broker.ts";
import { migrate } from "../../src/lib/server/domain/db/migrate.ts";
import { seedBootstrap } from "../../src/lib/server/domain/db/seed.ts";
import type { Emission } from "../../src/lib/server/domain/emission.ts";
import { indefinitely } from "../../src/lib/server/domain/iteration.ts";
import { buildServices, type Services } from "../../src/lib/server/domain/substrate.ts";
import { startTestSurface, type TestSurface } from "../harness/surface.ts";

const exec = promisify(execFile);

interface TempDb {
	adminUrl: string;
	appUrl: string;
	roUrl: string;
	writerUrl: string;
	stop(): Promise<void>;
}

async function startTempDb(): Promise<TempDb> {
	const name = `console-bus-rpc-test-${randomBytes(6).toString("hex")}`;
	await exec("docker", [
		"run",
		"-d",
		"--name",
		name,
		"-e",
		"POSTGRES_PASSWORD=pw",
		"-p",
		"0:5432",
		"timescale/timescaledb:latest-pg16",
	]);
	const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
	const port = Number(stdout.trim().split(":").pop());
	const base = `127.0.0.1:${String(port)}/postgres`;
	const adminUrl = `postgres://postgres:pw@${base}`;
	const deadline = Date.now() + 90_000;
	let streak = 0;
	for await (const iteration of indefinitely()) {
		void iteration;
		const probe = postgres(adminUrl, {
			max: 1,
			connect_timeout: 3,
			idle_timeout: 1,
			onnotice: () => {},
		});
		try {
			await probe`select 1`;
			streak += 1;
		} catch {
			streak = 0;
		} finally {
			await probe.end({ timeout: 2 }).catch(() => undefined);
		}
		if (streak >= 2) break;
		if (Date.now() > deadline) throw new Error("bus-rpc temp db never became ready");
		await new Promise((resolve) => setTimeout(resolve, 750));
	}
	return {
		adminUrl,
		appUrl: `postgres://console_app:apppw@${base}`,
		roUrl: `postgres://console_ro:ropw@${base}`,
		writerUrl: `postgres://console_writer:writerpw@${base}`,
		async stop() {
			await exec("docker", ["rm", "-f", name]).catch(() => undefined);
		},
	};
}

let temp: TempDb;
let services: Services;

const scope = "user:bus-rpc";
const principalHeader = JSON.stringify({
	kind: "human",
	id: "bus-rpc",
	tiers: [],
	lanes: ["viewer"],
	scopes: [scope],
});

function emission(over: Partial<Emission> = {}): Emission {
	return {
		schema_version: 1,
		id: randomUUID(),
		type: "test.bus_rpc",
		ts: new Date().toISOString(),
		source: { service: "console-api", host: null, agent: null },
		subject: "bus-rpc",
		severity: "info",
		scope,
		measures: { value: 1 },
		...over,
	};
}

beforeAll(async () => {
	temp = await startTempDb();
	const admin = postgres(temp.adminUrl, { onnotice: () => {} });
	await migrate(admin, { appPassword: "apppw", roPassword: "ropw", writerPassword: "writerpw" });
	await seedBootstrap(admin);
	await admin`insert into producer_registrations (subject, allowed_services, allowed_prefixes, allowed_scopes, max_severity)
		values ('test:emitter', ${admin.json(["console-api"])}, ${admin.json(["test"])}, ${admin.json([scope])}, 'p0')
		on conflict (subject) do nothing`;
	await admin`insert into grants (subject, relation, object, granted_by) values
		('test:emitter', 'editor', ${scope}, 'test'),
		('bus-rpc', 'viewer', ${scope}, 'test')`;
	await admin.end();
	services = await buildServices(
		{
			databaseUrl: temp.adminUrl,
			appDatabaseUrl: temp.appUrl,
			roDatabaseUrl: temp.roUrl,
			writerDatabaseUrl: temp.writerUrl,
			host: "127.0.0.1",
			port: 0,
			devAuth: true,
			glitchtipDsn: null,
			trackerDbPath: null,
		},
		{ migrate: false },
	);
}, 120_000);

afterAll(async () => {
	await services?.close();
	await temp?.stop();
});

/** WHATWG-style socket over the surface's in-memory bus bridge, so headers can authenticate. */
function surfaceWebSocket(surface: TestSurface, headers: Record<string, string>) {
	return (): BusWebSocket => {
		const listeners = {
			open: [] as (() => void)[],
			message: [] as ((event: { data: unknown }) => void)[],
			close: [] as (() => void)[],
		};
		let inner: Awaited<ReturnType<TestSurface["injectWS"]>> | undefined;
		const pending: string[] = [];
		void surface.injectWS("/api/v1/bus/ws", { headers }).then((socket) => {
			inner = socket;
			socket.on("message", (data) => {
				for (const listener of listeners.message) listener({ data });
			});
			for (const listener of listeners.open) listener();
			for (const frame of pending) socket.send(frame);
		});
		return {
			send(data) {
				if (inner) inner.send(data);
				else pending.push(data);
			},
			close() {
				inner?.close();
				for (const listener of listeners.close) listener();
			},
			addEventListener(type: string, listener: unknown) {
				if (type === "open") listeners.open.push(listener as () => void);
				else if (type === "message")
					listeners.message.push(listener as (event: { data: unknown }) => void);
				else if (type === "close") listeners.close.push(listener as () => void);
			},
		};
	};
}

describe("typed bus RPC client (Phase 2 contract)", () => {
	it("subscribes, receives schema-decoded acks and events, and re-fences on grant change", async () => {
		// A verifier (even one that defers to the dev principal) marks the connection refreshable,
		// arming the grant-change watch exactly as browser/bearer connections are.
		const surface = await startTestSurface(services, {
			betterAuth: {
				getIdentity: async () => null,
				getIdentityBySessionId: async () => null,
				close: async () => undefined,
			},
		});
		const frames: BusServerFrame[] = [];
		const protocolErrors: string[] = [];
		try {
			const client = connectBusClient({
				url: "ws://console.local/api/v1/bus/ws",
				webSocket: surfaceWebSocket(surface, { "x-dev-principal": principalHeader }),
				subscriptions: () => [{ sub_id: "bus-rpc-live", pattern: "test.**" }],
				reconnectDelayMs: 0,
				onFrame: (frame) => frames.push(frame),
				onProtocolError: (_raw, message) => protocolErrors.push(message),
			});
			await expect
				.poll(() => frames.some((frame) => frame.kind === "ack" && frame.sub_id === "bus-rpc-live"))
				.toBe(true);
			const live = emission();
			expect((await services.emit("test:emitter", live, 300)).ok).toBe(true);
			await expect
				.poll(() => frames.some((frame) => frame.kind === "event" && frame.emission.id === live.id))
				.toBe(true);
			const event = frames.find((frame) => frame.kind === "event");
			expect(event).toMatchObject({
				kind: "event",
				sub_id: "bus-rpc-live",
				emission: { type: "test.bus_rpc", scope, severity: "info" },
			});
			expect(typeof (event as { seq: number }).seq).toBe("number");
			expect(protocolErrors).toEqual([]);

			// Narrow the caller's grants and poke the LISTEN channel: the live subscription must be
			// dropped with resync_required, not silently retained on stale scopes.
			await services.db.admin`delete from grants where subject = 'bus-rpc' and object = ${scope}`;
			await services.db.admin`select pg_notify('console_grants_changed', 'bus-rpc-test')`;
			await expect
				.poll(
					() =>
						frames.some(
							(frame) => frame.kind === "resync_required" && frame.sub_id === "bus-rpc-live",
						),
					{ timeout: 5_000 },
				)
				.toBe(true);
			client.close();
		} finally {
			await services.db.admin`insert into grants (subject, relation, object, granted_by)
				values ('bus-rpc', 'viewer', ${scope}, 'test') on conflict do nothing`;
			await surface.close();
		}
	}, 30_000);

	it("reports resync_required instead of going live when the replay is incomplete", async () => {
		const broken = new Broker(() => Promise.reject(new Error("replay backend unavailable")));
		const surface = await startTestSurface({ ...services, broker: broken });
		const frames: BusServerFrame[] = [];
		try {
			const client = connectBusClient({
				url: "ws://console.local/api/v1/bus/ws",
				webSocket: surfaceWebSocket(surface, { "x-dev-principal": principalHeader }),
				subscriptions: () => [{ sub_id: "bus-rpc-resync", pattern: "test.**", since: 1 }],
				reconnectDelayMs: 0,
				onFrame: (frame) => frames.push(frame),
			});
			await expect
				.poll(() =>
					frames.some(
						(frame) => frame.kind === "resync_required" && frame.sub_id === "bus-rpc-resync",
					),
				)
				.toBe(true);
			const resync = frames.find((frame) => frame.kind === "resync_required");
			expect(resync).toMatchObject({ kind: "resync_required", sub_id: "bus-rpc-resync" });
			expect(typeof (resync as { oldest_seq: number }).oldest_seq).toBe("number");
			client.close();
		} finally {
			await surface.close();
		}
	}, 30_000);

	it("unsubscribes on socket close (connection bookkeeping reaches the broker)", async () => {
		const unsubscribed: string[] = [];
		const broker = services.broker;
		const recording = {
			get head() {
				return broker.head;
			},
			setHead: broker.setHead.bind(broker),
			onEvent: broker.onEvent.bind(broker),
			subscribe: broker.subscribe.bind(broker),
			revalidateScopes: broker.revalidateScopes.bind(broker),
			unsubscribe(ownerId: string, subId: string) {
				unsubscribed.push(subId);
				broker.unsubscribe(ownerId, subId);
			},
		};
		const surface = await startTestSurface({ ...services, broker: recording as never });
		const frames: BusServerFrame[] = [];
		try {
			const client = connectBusClient({
				url: "ws://console.local/api/v1/bus/ws",
				webSocket: surfaceWebSocket(surface, { "x-dev-principal": principalHeader }),
				subscriptions: () => [{ sub_id: "bus-rpc-close", pattern: "test.**" }],
				reconnectDelayMs: 0,
				onFrame: (frame) => frames.push(frame),
			});
			await expect
				.poll(() =>
					frames.some((frame) => frame.kind === "ack" && frame.sub_id === "bus-rpc-close"),
				)
				.toBe(true);
			expect(surface.busCounters().subscriptions).toBe(1);
			client.close();
			await expect.poll(() => unsubscribed.includes("bus-rpc-close")).toBe(true);
			expect(surface.busCounters().subscriptions).toBe(0);
		} finally {
			await surface.close();
		}
	}, 30_000);
});
