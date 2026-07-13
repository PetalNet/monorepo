import { describe, expect, it, vi } from "vitest";

import { HttpMatrixTransport, MatrixDeliveryError } from "../src/notifications/matrix.ts";

const config = {
	homeserver: "https://matrix.example.test",
	accessToken: "secret-token",
	ownerBindings: { parker: "@parker:example.test" },
};

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("HttpMatrixTransport", () => {
	it("rejects a user target that is not bound to the console principal", async () => {
		const fetchFn = vi.fn<typeof fetch>();
		const matrix = new HttpMatrixTransport(config, fetchFn);
		await expect(matrix.assertOwnedTarget("parker", "@other:example.test")).rejects.toMatchObject({
			code: "target_not_owned",
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("proves room membership for both the sender and bound owner before sending", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ joined_rooms: ["!family:example.test"] }))
			.mockResolvedValueOnce(response({ membership: "join" }))
			.mockResolvedValueOnce(response({ event_id: "$event" }));
		const matrix = new HttpMatrixTransport(config, fetchFn);
		const receipt = await matrix.send(
			"parker",
			"!family:example.test",
			"Test from the lab.",
			"txn-1",
		);
		expect(receipt).toEqual({ eventId: "$event", roomId: "!family:example.test" });
		expect(fetchFn).toHaveBeenCalledTimes(3);
		const [sendUrl, sendInit] = fetchFn.mock.calls[2]!;
		expect(String(sendUrl)).toContain("/send/m.room.message/txn-1");
		expect(sendInit?.method).toBe("PUT");
		expect(JSON.parse(String(sendInit?.body))).toEqual({
			msgtype: "m.text",
			body: "Test from the lab.",
		});
	});

	it("reuses the account's existing direct room for a verified user target", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ user_id: "@sender:example.test" }))
			.mockResolvedValueOnce(response({ "@parker:example.test": ["!direct:example.test"] }))
			.mockResolvedValueOnce(response({ event_id: "$direct-event" }));
		const matrix = new HttpMatrixTransport(config, fetchFn);
		const receipt = await matrix.send("parker", "@parker:example.test", "hello", "txn-2");
		expect(receipt.roomId).toBe("!direct:example.test");
		expect(String(fetchFn.mock.calls[2]![0])).toContain(encodeURIComponent("!direct:example.test"));
	});

	it("preserves Matrix error codes and retryability", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ errcode: "M_LIMIT_EXCEEDED", error: "slow down" }, 429));
		const matrix = new HttpMatrixTransport(config, fetchFn);
		const error = await matrix
			.send("parker", "!family:example.test", "hello", "txn-3")
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(MatrixDeliveryError);
		expect(error).toMatchObject({ code: "M_LIMIT_EXCEEDED", retryable: true });
	});
});
