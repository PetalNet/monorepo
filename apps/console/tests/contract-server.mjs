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

function bodyFor(path, method) {
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
		const body = bodyFor(url.pathname, request.method ?? "GET");
		if (body !== null)
			return response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(body));
		response.writeHead(404, { "content-type": "application/json" }).end("{}");
	});
});

server.listen(43174, "127.0.0.1");
