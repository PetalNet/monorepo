import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "./domain/auth/principal";

const mocks = vi.hoisted(() => ({
	attachBusConnection: vi.fn(),
	apiResolvePrincipal: vi.fn<() => Promise<Principal | null>>(),
	state: { browserOrigin: null as string | null },
}));

vi.mock("./api/instance", () => ({
	consoleApi: () =>
		Promise.resolve({
			browserOrigin: mocks.state.browserOrigin,
			resolvePrincipal: mocks.apiResolvePrincipal,
			busCounters: { clients: 0, subscriptions: 0 },
		}),
	consoleServices: () => Promise.resolve({}),
}));
vi.mock("./domain/bus/connection", () => ({ attachBusConnection: mocks.attachBusConnection }));

import { handleWebsocket } from "./ws";

const CONSOLE_ORIGIN = "https://console.test";

const principal: Principal = {
	kind: "human",
	id: "human:u1",
	tiers: ["viewer"],
	lanes: ["viewer"],
	scopes: ["user:u1"],
	zookie: "z0",
};

interface TestUpgrade {
	event: Parameters<typeof handleWebsocket>[0];
	close: ReturnType<typeof vi.fn>;
}

const upgrade = (headers: Record<string, string>, path = "/api/v1/bus/ws"): TestUpgrade => {
	const close = vi.fn();
	const event = {
		socket: {
			send: vi.fn(),
			close,
			terminate: vi.fn(),
			isOpen: () => true,
			on: vi.fn(),
		},
		peer: { send: vi.fn() },
		request: {
			url: Object.freeze(new URL(`${CONSOLE_ORIGIN}${path}`)),
			headers: new Headers(headers),
			protocol: "wss",
		},
		locals: {},
	} as unknown as Parameters<typeof handleWebsocket>[0];
	return { event, close };
};

describe("websocket upgrade origin gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.state.browserOrigin = CONSOLE_ORIGIN;
	});

	it("denies a cross-origin cookie upgrade before any cookie auth is resolved", async () => {
		const denied = async (path: string): Promise<void> => {
			const { event, close } = upgrade(
				{ origin: "https://attacker.example", cookie: "console.session_token=stolen" },
				path,
			);
			await handleWebsocket(event);
			expect(close).toHaveBeenCalledWith(1008, "origin is not allowed");
		};
		await denied("/api/v1/bus/ws");
		await denied("/api/v1/terminal/ws");
		expect(mocks.attachBusConnection).not.toHaveBeenCalled();
		expect(mocks.apiResolvePrincipal).not.toHaveBeenCalled();
	});

	it("attaches a same-origin cookie upgrade and still resolves the session chain", async () => {
		mocks.apiResolvePrincipal.mockResolvedValue(principal);
		const { event, close } = upgrade({
			origin: CONSOLE_ORIGIN,
			cookie: "console.session_token=valid",
		});
		await handleWebsocket(event);
		expect(close).not.toHaveBeenCalled();
		expect(mocks.attachBusConnection).toHaveBeenCalledTimes(1);
		const options = mocks.attachBusConnection.mock.calls[0]?.[1] as {
			resolvePrincipal: () => Promise<Principal | null>;
		};
		await expect(options.resolvePrincipal()).resolves.toBe(principal);
		expect(mocks.apiResolvePrincipal).toHaveBeenCalledWith(
			expect.objectContaining({}),
			"console.test",
		);
	});

	it("leaves upgrades without an Origin header origin-agnostic (agent bearer clients)", async () => {
		const { event, close } = upgrade({ authorization: "Bearer agent-token" });
		await handleWebsocket(event);
		expect(close).not.toHaveBeenCalled();
		expect(mocks.attachBusConnection).toHaveBeenCalledTimes(1);
	});

	it("applies no gate when no browser origin is configured, exactly like the HTTP path", async () => {
		mocks.state.browserOrigin = null;
		const { event, close } = upgrade({ origin: "https://elsewhere.example" });
		await handleWebsocket(event);
		expect(close).not.toHaveBeenCalled();
		expect(mocks.attachBusConnection).toHaveBeenCalledTimes(1);
	});
});
