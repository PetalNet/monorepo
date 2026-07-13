import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	capture: vi.fn(),
	readAttention: vi.fn(),
	readBoxUpdateRaw: vi.fn(),
	readBoxUpdates: vi.fn(),
	readCatalog: vi.fn(),
	readDashboards: vi.fn(),
	readEdgeRegistry: vi.fn(),
	readEdgeSessions: vi.fn(),
	readExecutors: vi.fn(),
	readHealth: vi.fn(),
	readRoster: vi.fn(),
	runQuery: vi.fn(),
}));

vi.mock("$app/environment", () => ({ browser: false }));
vi.mock("$lib/glitchtip", () => ({ captureCaughtFailure: mocks.capture }));
vi.mock("$lib/api/client", () => ({
	dataMode: () => "live",
	readAttention: mocks.readAttention,
	readBoxUpdateRaw: mocks.readBoxUpdateRaw,
	readBoxUpdates: mocks.readBoxUpdates,
	readCatalog: mocks.readCatalog,
	readDashboards: mocks.readDashboards,
	readEdgeRegistry: mocks.readEdgeRegistry,
	readEdgeSessions: mocks.readEdgeSessions,
	readExecutors: mocks.readExecutors,
	readHealth: mocks.readHealth,
	readRoster: mocks.readRoster,
	runQuery: mocks.runQuery,
}));

import { load as loadCockpit } from "./+page";
import { load as loadNetwork } from "./network/+page";
import { load as loadObservability } from "./observability/+page";
import { load as loadUpdates } from "./updates/+page";

const failure = new TypeError("private contract detail");
const fetchStub = vi.fn() as unknown as typeof fetch;
const shell = {
	me: { id: "parker", lanes: ["admin"] },
	scene: "clear",
};
const contexts = () => mocks.capture.mock.calls.map(([, context]) => context);

beforeEach(() => {
	vi.clearAllMocks();
	for (const read of Object.values(mocks)) {
		if (read !== mocks.capture && "mockRejectedValue" in read) read.mockRejectedValue(failure);
	}
});

describe("caught loader failure contracts", () => {
	it("maps Cockpit reads to stable endpoint labels", async () => {
		await loadCockpit({
			fetch: fetchStub,
			parent: async () => shell,
		} as never);

		expect(mocks.capture).toHaveBeenCalledTimes(4);
		expect(contexts()).toEqual(
			expect.arrayContaining(
				["/attention", "/roster", "/health", "/dashboards"].map((endpoint) => ({
					surface: "cockpit",
					endpoint,
				})),
			),
		);
	});

	it("maps Network reads to stable endpoint labels", async () => {
		await loadNetwork({ fetch: fetchStub, parent: async () => shell } as never);

		expect(contexts()).toEqual([
			{ surface: "network", endpoint: "/executors" },
			{ surface: "network", endpoint: "/edge/sessions" },
		]);
	});

	it("maps Updates reads to stable endpoint labels", async () => {
		await loadUpdates({ fetch: fetchStub, parent: async () => shell } as never);

		expect(mocks.capture).toHaveBeenCalledWith(failure, {
			surface: "updates",
			endpoint: "/box-updates",
		});
	});

	it("maps partial Updates reads, including raw detail, to route templates", async () => {
		mocks.readBoxUpdates.mockResolvedValue({
			items: [{ box_id: "private-box", raw_ref: "raw-1" }],
			freshness: {},
		});

		await loadUpdates({ fetch: fetchStub, parent: async () => shell } as never);

		expect(contexts()).toEqual([
			{ surface: "updates", endpoint: "/executors" },
			{ surface: "updates", endpoint: "/box-updates/:box_id/raw" },
		]);
	});

	it("maps Observability reads to stable endpoint labels", async () => {
		await loadObservability({ fetch: fetchStub, parent: async () => shell } as never);

		expect(contexts()).toEqual(
			expect.arrayContaining([
				{ surface: "observability", endpoint: "/query/events" },
				{ surface: "observability", endpoint: "/query/freshness" },
				{ surface: "observability", endpoint: "/query/queries" },
				{ surface: "observability", endpoint: "/query/emitters" },
				{ surface: "observability", endpoint: "/catalog" },
				{ surface: "observability", endpoint: "/dashboards" },
				{ surface: "observability", endpoint: "/executors" },
			]),
		);
		expect(mocks.capture).toHaveBeenCalledTimes(7);
	});
});
