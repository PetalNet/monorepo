import { createServer as createHttpServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { TrackerCommandError, TrackerCommandWriter } from "../../src/lib/server/domain/commands/tracker.ts";

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

async function trackerServer(
	respond: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ url: string; calls: { authorization?: string; body: Record<string, unknown> }[] }> {
	const calls: { authorization?: string; body: Record<string, unknown> }[] = [];
	const server = createHttpServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			const body = JSON.parse(raw) as Record<string, unknown>;
			calls.push({ authorization: request.headers.authorization, body });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(respond(body)));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("tracker test server did not bind");
	return { url: `http://127.0.0.1:${String(address.port)}/api/agent/rpc`, calls };
}

describe("TrackerCommandWriter", () => {
	it("claims the requested task through the canonical atomic tracker RPC and scrubs the token", async () => {
		const tracker = await trackerServer(() => ({
			claimed: { id: 746, title: "Vega panel goldens", status: "doing" },
			token: "server-only-lease-secret",
		}));
		const writer = new TrackerCommandWriter({ url: tracker.url, token: "tracker-bearer" });

		const result = await writer.claim({ taskId: 746, capability: "charts" });

		expect(tracker.calls).toEqual([
			{
				authorization: "Bearer tracker-bearer",
				body: { op: "claim", args: { id: 746, capability: "charts" } },
			},
		]);
		expect(result).toEqual({ task_id: 746, status: "doing" });
		expect(JSON.stringify(result)).not.toContain("server-only-lease-secret");
	});

	it("reports a normal lost race when the requested task was not claimed", async () => {
		const tracker = await trackerServer(() => ({ claimed: null }));
		const writer = new TrackerCommandWriter({ url: tracker.url, token: "tracker-bearer" });

		await expect(writer.claim({ taskId: 746 })).rejects.toMatchObject<TrackerCommandError>({
			code: "claim_lost",
			retryable: false,
		});
	});
});
