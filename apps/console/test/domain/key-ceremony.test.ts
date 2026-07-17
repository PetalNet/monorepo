import { describe, expect, it, vi } from "vitest";

import { DoormanKeyCeremonyClient, KeyCeremonyError } from "../../src/lib/server/domain/network/key-ceremony.ts";

describe("DoormanKeyCeremonyClient", () => {
	it("forwards an approved binding with bearer auth and request id", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				ok: true,
				result: {
					pubkey_fp: "a".repeat(64),
					handle: "mc34",
					state: "enrolled",
					applied_at: "2026-07-13T12:00:00Z",
				},
			}),
		);
		const client = new DoormanKeyCeremonyClient({
			url: "http://127.0.0.1:8043/v1/key-ceremony/",
			token: "secret",
			fetch,
		});

		await expect(
			client.approve({
				requestId: "request-1",
				pubkeyFp: "a".repeat(64),
				handle: "mc34",
				principal: "parker",
			}),
		).resolves.toMatchObject({ state: "enrolled", handle: "mc34" });
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(String(url)).toBe("http://127.0.0.1:8043/v1/key-ceremony/approve");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
		expect(JSON.parse(String(init?.body))).toEqual({
			request_id: "request-1",
			pubkey_fp: "a".repeat(64),
			handle: "mc34",
			principal: "parker",
		});
	});

	it("preserves a bounded doorman rejection", async () => {
		const client = new DoormanKeyCeremonyClient({
			url: "http://127.0.0.1:8043/",
			token: "secret",
			fetch: async () =>
				Response.json(
					{
						ok: false,
						error: {
							code: "key_not_pending",
							message: "Key is no longer pending",
							retryable: false,
						},
					},
					{ status: 409 },
				),
		});

		const error = await client
			.deny({
				requestId: "request-2",
				pubkeyFp: "b".repeat(64),
				reason: "unknown device",
				principal: "parker",
			})
			.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(KeyCeremonyError);
		expect(error).toMatchObject({ code: "key_not_pending", retryable: false });
	});

	it("fails health closed when the edge cannot be reached", async () => {
		const client = new DoormanKeyCeremonyClient({
			url: "http://127.0.0.1:8043/",
			token: "secret",
			fetch: async () => {
				throw new Error("connection refused");
			},
		});
		await expect(client.health()).resolves.toBe(false);
	});

	it("rejects a successful response for a different key or terminal state", async () => {
		const client = new DoormanKeyCeremonyClient({
			url: "http://127.0.0.1:8043/",
			token: "secret",
			fetch: async () =>
				Response.json({
					ok: true,
					result: {
						pubkey_fp: "c".repeat(64),
						handle: "someone-else",
						state: "revoked",
						applied_at: "2026-07-13T12:00:00Z",
					},
				}),
		});

		await expect(
			client.approve({
				requestId: "request-3",
				pubkeyFp: "a".repeat(64),
				handle: "mc34",
				principal: "parker",
			}),
		).rejects.toMatchObject({ code: "doorman_invalid_result", retryable: false });
	});

	it("requires an explicit positive health payload", async () => {
		const client = new DoormanKeyCeremonyClient({
			url: "http://127.0.0.1:8043/",
			token: "secret",
			fetch: async () => Response.json({ status: "up" }),
		});
		await expect(client.health()).resolves.toBe(false);
	});
});
