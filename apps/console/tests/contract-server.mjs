import { createServer } from "node:http";
import { URL } from "node:url";

let failures = new Set();
let envelopes = [];
let operations = [];
let assistantMessages = [];
const observedAt = "2026-07-13T12:00:00.000Z";
const envelope = (items) => ({
	schema_version: 1,
	freshness: { source: "contract-mock", observed_at: observedAt, window_s: 60 },
	items,
	next_cursor: null,
});

function bodyFor(path, method, requestBody = null) {
	if (path === "/api/v1/me")
		return {
			schema_version: 1,
			kind: "human",
			id: "parker",
			display_name: "Parker",
			grant_name: "lab-admin",
			tiers: ["admin"],
			lanes: ["viewer", "editor", "operator", "admin"],
			scopes: ["lab"],
			zookie: "test-zookie",
		};
	if (path === "/api/v1/health")
		return { lake: "ok", seq_head: 42, bridges: [{ observed_at: observedAt }], ws_clients: 1 };
	if (path === "/api/v1/attention" || path === "/api/v1/roster" || path === "/api/v1/dashboards")
		return envelope([]);
	if (path === "/api/v1/edge/registry") return envelope([]);
	if (path === "/api/v1/edge/sessions")
		return envelope([
			{
				session_id: "line-1",
				handle: "janet",
				host: ".202",
				state: "closed",
				established_at: "2026-07-13T11:55:00.000Z",
				last_seen_at: "2026-07-13T11:59:30.000Z",
				resumes_count: 1,
				handshakes_clean_count: 8,
				links: [],
			},
		]);
	if (path === "/api/v1/executors")
		return envelope([
			{ kind: "manager", liveness: "alive" },
			{ kind: "edge", liveness: "alive" },
			{ kind: "control-plane", liveness: "alive" },
		]);
	if (path === "/api/v1/box-updates") return envelope([]);
	if (path === "/api/v1/catalog") return envelope([]);
	if (path === "/api/v1/palette/search")
		return {
			schema_version: 1,
			freshness: { source: "palette", observed_at: new Date().toISOString(), window_s: 0 },
			query: "carson",
			items: [
				{
					id: "agent:carson-2",
					kind: "agent",
					label: "Carson 2",
					description: "@carson-2 · builder · .14",
					href: "/agents?agent=carson-2",
					meta: "resident",
					score: 200,
				},
			],
			sources: {
				agents: "live",
				tasks: "live",
				library: "live",
				hosts: "live",
				statistics: "live",
			},
		};
	if (path === "/api/v1/assistant/messages" && method === "POST")
		return {
			schema_version: 1,
			session_id: "session-test",
			message_id: "assistant-test",
			content: "Contract answer.",
			tool_results: [],
		};
	if (path === "/api/v1/assistant/context" && method === "POST")
		return { schema_version: 1, message_id: "context-test", content: "Context accepted." };
	if (path === "/api/v1/cost/compare" && method === "POST") {
		const left = requestBody?.left ?? "claude-opus-4-8";
		const right = requestBody?.right ?? "claude-sonnet-5";
		const leftSide = {
			value: left,
			cost: 27.3,
			tokens: 15_200_000,
			sessions: 8,
			cost_per_session: 3.4125,
			tokens_per_session: 1_900_000,
			input_tokens: 740_000,
			output_tokens: 410_000,
			cache_creation_tokens: 610_000,
			cache_read_tokens: 13_440_000,
		};
		const rightSide = {
			value: right,
			cost: 1.6,
			tokens: 1_340_000,
			sessions: 4,
			cost_per_session: 0.4,
			tokens_per_session: 335_000,
			input_tokens: 120_000,
			output_tokens: 70_000,
			cache_creation_tokens: 150_000,
			cache_read_tokens: 1_000_000,
		};
		const keys = [
			"cost",
			"tokens",
			"sessions",
			"cost_per_session",
			"tokens_per_session",
			"input_tokens",
			"output_tokens",
			"cache_creation_tokens",
			"cache_read_tokens",
		];
		return {
			schema_version: 1,
			dimension: requestBody?.dimension ?? "model",
			left: leftSide,
			right: rightSide,
			metrics: keys.map((key) => ({
				key,
				left: leftSide[key],
				right: rightSide[key],
				delta: rightSide[key] - leftSide[key],
				ratio: leftSide[key] === 0 ? null : rightSide[key] / leftSide[key],
			})),
			query_ref: "query-cost-compare",
			pricing_query_ref: "query-price-book",
			observed_at: observedAt,
			receipt: {
				source: "agentsview",
				scope: `model: ${left} ↔ ${right}`,
				query: "GET /usage/pairwise-comparison?fixture=1",
				row_count: 12,
				session_count: 12,
				execution_ms: 18,
				cost_source: "computed",
				pricing: {
					source: "fetched",
					table_version: "2026-07-13T14:00:59Z",
					digest: "sha256:fixture-price-book",
					effective_row_count: 2511,
					models: [left, right].map((model) => ({
						model,
						matched_pattern: model,
						input_per_mtok: 5,
						output_per_mtok: 25,
						cache_creation_per_mtok: 6.25,
						cache_read_per_mtok: 0.5,
					})),
				},
			},
		};
	}
	if (path === "/api/v1/query" && method === "POST" && requestBody?.from === "model_pricing")
		return {
			schema_version: 1,
			columns: [
				"model_pattern",
				"input_per_mtok",
				"output_per_mtok",
				"cache_creation_per_mtok",
				"cache_read_per_mtok",
			].map((name) => ({ name, type: name === "model_pattern" ? "string" : "number" })),
			rows: [
				["claude-opus-4-8", 5, 25, 6.25, 0.5],
				["claude-sonnet-5", 2, 10, 2.5, 0.2],
			],
			row_count: 2,
			freshness: { source: "contract-mock", observed_at: observedAt, window_s: 60 },
			query_ref: "query-price-book",
		};
	if (path === "/api/v1/query" && method === "POST" && requestBody?.from === "usage_events")
		return {
			schema_version: 1,
			columns: [
				"session_id",
				"started_at",
				"agent",
				"model",
				"project",
				"task_id",
				"input_tokens",
				"output_tokens",
				"cache_creation_tokens",
				"cache_read_tokens",
				"reported_cost",
			].map((name) => ({
				name,
				type: [
					"task_id",
					"input_tokens",
					"output_tokens",
					"cache_creation_tokens",
					"cache_read_tokens",
					"reported_cost",
				].includes(name)
					? "number"
					: "string",
			})),
			rows: [
				[
					"session-opus",
					"2026-07-13T10:00:00.000Z",
					"carson-2",
					"claude-opus-4-8",
					"Lab Console",
					716,
					240_000,
					140_000,
					160_000,
					2_800_000,
					0,
				],
				[
					"session-sonnet",
					"2026-07-13T11:00:00.000Z",
					"janet",
					"claude-sonnet-5",
					"Lab Console",
					716,
					120_000,
					70_000,
					150_000,
					1_000_000,
					0,
				],
			],
			row_count: 2,
			freshness: { source: "contract-mock", observed_at: observedAt, window_s: 60 },
			query_ref: "query-cost-usage",
		};
	if (path === "/api/v1/query" && method === "POST")
		return {
			schema_version: 1,
			columns: [],
			rows: [],
			row_count: 0,
			freshness: { source: "contract-mock", observed_at: observedAt },
			query_ref: "query-test",
		};
	return null;
}

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1:43174");
	response.setHeader("access-control-allow-origin", "http://127.0.0.1:43173");
	response.setHeader("access-control-allow-credentials", "true");
	response.setHeader("access-control-allow-headers", "content-type,sentry-trace,baggage");
	response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
	if (request.method === "OPTIONS") return response.writeHead(204).end();

	let raw = "";
	request.on("data", (chunk) => (raw += chunk));
	request.on("end", () => {
		if (
			url.pathname === "/api/v1/me" &&
			!request.headers.cookie?.includes("auth_session=e2e-session")
		)
			return response
				.writeHead(401, { "content-type": "application/json" })
				.end(
					JSON.stringify({ code: "unauthenticated", message: "login required", retryable: false }),
				);
		if (url.pathname === "/__test/reset") {
			failures = new Set();
			envelopes = [];
			operations = [];
			assistantMessages = [];
			return response.writeHead(204).end();
		}
		if (url.pathname === "/__test/fail") {
			failures.add(url.searchParams.get("path"));
			return response.writeHead(204).end();
		}
		if (url.pathname === "/__test/envelopes")
			return response.writeHead(200, { "content-type": "text/plain" }).end(envelopes.join("\n"));
		if (url.pathname === "/__test/operations")
			return response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(operations));
		if (url.pathname === "/__test/messages")
			return response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(assistantMessages));
		if (url.pathname.includes("/api/1/envelope/")) {
			envelopes.push(raw);
			return response.writeHead(200, { "content-type": "application/json" }).end("{}");
		}
		if (failures.has(url.pathname))
			return response.writeHead(503, { "content-type": "application/json" }).end(
				JSON.stringify({
					code: "contract_down",
					message: "private upstream detail",
					retryable: true,
				}),
			);
		if (url.pathname === "/api/v1/op" && request.method === "POST") {
			operations.push(JSON.parse(raw));
			return response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ schema_version: 1, status: "accepted", undo: null }));
		}
		if (url.pathname === "/api/v1/assistant/messages" && request.method === "POST")
			assistantMessages.push(JSON.parse(raw));
		const requestBody = raw ? JSON.parse(raw) : null;
		const body = bodyFor(url.pathname, request.method ?? "GET", requestBody);
		if (body !== null)
			return response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(body));
		response.writeHead(404, { "content-type": "application/json" }).end("{}");
	});
});

server.listen(43174, "127.0.0.1");
