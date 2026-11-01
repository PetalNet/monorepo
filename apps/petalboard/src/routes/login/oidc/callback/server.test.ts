import type { Cookies } from "@sveltejs/kit";
import { describe, expect, it, vi } from "vitest";

import { GET } from "./+server";

describe("OIDC callback", () => {
	it("rejects a bogus state before calling the token endpoint", async () => {
		const fetcher = vi.spyOn(globalThis, "fetch");
		const url = new URL("https://board.example.test/login/oidc/callback?state=bogus&code=code");
		const cookies = {
			get: vi
				.fn<Cookies["get"]>()
				.mockReturnValue(
					Buffer.from(
						JSON.stringify({ state: "expected", nonce: "nonce", verifier: "verifier" }),
					).toString("base64url"),
				),
			getAll: vi.fn<Cookies["getAll"]>().mockReturnValue([]),
			set: vi.fn<Cookies["set"]>(),
			delete: vi.fn<Cookies["delete"]>(),
			serialize: vi.fn<Cookies["serialize"]>().mockReturnValue(""),
		} satisfies Cookies;
		const event = {
			cookies,
			fetch: globalThis.fetch,
			getClientAddress: () => "127.0.0.1",
			locals: { user: null },
			params: {},
			platform: undefined,
			request: new Request(url),
			route: { id: "/login/oidc/callback" },
			setHeaders: vi.fn(),
			url,
			isDataRequest: false,
			isSubRequest: false,
			tracing: Object.create(null),
			isRemoteRequest: false,
		} satisfies Parameters<typeof GET>[0];

		await expect(GET(event)).rejects.toMatchObject({ status: 400 });

		expect(cookies.delete).toHaveBeenCalledWith("oidc_tx", { path: "/login/oidc" });
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockRestore();
	});
});
