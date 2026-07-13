import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { describe, it, expect } from "vitest";

import { OpenAiCompatibleAssistantCompiler } from "../src/assistant/compiler.ts";
import { matchPattern } from "../src/bus/broker.ts";
import { parseEmission, type Emission } from "../src/emission.ts";
import { authorizeEmission, type ProducerRegistration } from "../src/ingest/authz.ts";
import { scrubEmission } from "../src/ingest/scrubber.ts";
import { materializePanel } from "../src/render/engine.ts";

function emission(over: Partial<Emission> = {}): Emission {
	return {
		schema_version: 1,
		id: randomUUID(),
		type: "host.cpu.pct",
		ts: new Date().toISOString(),
		source: { service: "bridge", host: ".15", agent: null },
		subject: ".15",
		severity: "info",
		scope: "fleet",
		...over,
	};
}

describe("emission parsing", () => {
	it("accepts a valid emission", () => {
		const r = parseEmission(emission(), 200);
		expect(r.ok).toBe(true);
	});
	it("rejects an unscoped emission", () => {
		const bad = emission();
		const { scope: _drop, ...rest } = bad;
		void _drop;
		expect(parseEmission(rest, 200).ok).toBe(false);
	});
	it("rejects a bad type name", () => {
		expect(parseEmission(emission({ type: "NotADotted" }), 200).ok).toBe(false);
	});
	it("rejects an oversized payload", () => {
		expect(parseEmission(emission(), 20000).code).toBe("payload_too_large");
	});
});

describe("secret scrubber", () => {
	it("rejects a claim_token in dimensions", () => {
		const e = emission({ dimensions: { claim_token: "abc" } });
		expect(scrubEmission(e).ok).toBe(false);
	});
	it("rejects a token-shaped value", () => {
		const e = emission({ dimensions: { note: "ghp_0123456789012345678901" } });
		expect(scrubEmission(e).ok).toBe(false);
	});
	it("passes a clean emission", () => {
		expect(scrubEmission(emission({ dimensions: { link_id: "b" } })).ok).toBe(true);
	});
	it("rejects a secret in the top-level action field", () => {
		expect(
			scrubEmission(
				emission({ action: "curl -H 'Authorization: Bearer sk-0123456789012345678901'" }),
			).ok,
		).toBe(false);
	});
	it("rejects a bare JWT in a link id", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
		expect(
			scrubEmission(emission({ links: [{ rel: "runs_on", to: { kind: "host", id: jwt } }] })).ok,
		).toBe(false);
	});
});

describe("emit authorization", () => {
	const reg: ProducerRegistration = {
		subject: "bridge:hosts",
		allowedServices: ["bridge"],
		allowedTypePrefixes: ["host", "container"],
		allowedScopes: ["fleet"],
		maxSeverity: "warn",
		maxEmitPerMinute: 6000,
		maxNewTypesPerHour: 20,
	};
	it("allows a permitted emission", () => {
		expect(authorizeEmission(reg, emission()).ok).toBe(true);
	});
	it("denies a foreign source", () => {
		expect(
			authorizeEmission(reg, emission({ source: { service: "manager", host: null, agent: null } }))
				.code,
		).toBe("source_mismatch");
	});
	it("denies a reserved namespace", () => {
		expect(authorizeEmission(reg, emission({ type: "audit.op" })).code).toBe("namespace_reserved");
	});
	it("denies a foreign scope", () => {
		expect(authorizeEmission(reg, emission({ scope: "user:parker" })).code).toBe("scope_denied");
	});
	it("denies over-cap severity", () => {
		expect(authorizeEmission(reg, emission({ severity: "p0" })).code).toBe("severity_denied");
	});
});

describe("pattern matching", () => {
	it("exact", () => expect(matchPattern("host.cpu.pct", "host.cpu.pct")).toBe(true));
	it("trailing glob crosses segments", () =>
		expect(matchPattern("doorman.*", "doorman.link.flap")).toBe(true));
	it("prefix glob miss", () => expect(matchPattern("doorman.*", "host.cpu.pct")).toBe(false));
	it("single star stays within one segment", () => {
		expect(matchPattern("host.*.pct", "host.cpu.pct")).toBe(true);
		expect(matchPattern("host.*.pct", "host.rack.cpu.pct")).toBe(false);
	});
	it("globstar matches the exact Signals subscription", () => {
		expect(matchPattern("**", "host.cpu.pct")).toBe(true);
		expect(matchPattern("**", "task.claimed")).toBe(true);
	});
	it.each([
		["task.**", "task.claimed"],
		["task.**", "task.review.requested"],
		["card.**", "card.posted"],
		["artifact.**", "artifact.build.completed"],
	])("matches frontend pattern %s against %s", (pattern, type) => {
		expect(matchPattern(pattern, type)).toBe(true);
	});
	it("globstar does not consume a partial segment", () =>
		expect(matchPattern("task.**", "taskish.claimed")).toBe(false));
	it("suffix glob", () => expect(matchPattern("*.flap", "doorman.flap")).toBe(true));
	it("suffix single-star does not cross segments", () =>
		expect(matchPattern("*.flap", "doorman.link.flap")).toBe(false));
});

describe("assistant compiler boundary", () => {
	it("accepts strict structured intent and rejects model-authored SQL", async () => {
		let includeSql = false;
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									feasible: true,
									request: {
										schema_version: 1,
										mode: "structured",
										from: "host.cpu.pct",
										select: [{ field: "pct", agg: "avg", as: "cpu" }],
										...(includeSql ? { sql: "drop table events" } : {}),
									},
									panel: { type: "stat", title: "CPU", encoding: { value: "cpu" } },
								}),
							},
						},
					],
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("test server unavailable");
			const compiler = new OpenAiCompatibleAssistantCompiler({
				url: `http://127.0.0.1:${String(address.port)}`,
				model: "test",
			});
			const context = [
				{
					kind: "statistic" as const,
					source_ref: "host.cpu.pct",
					content: "measure pct gauge",
					score: 1,
				},
			];
			expect((await compiler.compile({ question: "average cpu", context })).request?.from).toBe(
				"host.cpu.pct",
			);
			includeSql = true;
			await expect(compiler.compile({ question: "average cpu", context })).rejects.toThrow(
				/invalid structured intent/,
			);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});

describe("renderer-agnostic graph output", () => {
	it("selects charts from dimension × measure × cardinality", () => {
		const result = {
			schema_version: 1 as const,
			columns: [
				{ name: "zone", type: "string" },
				{ name: "latency", type: "number" },
			],
			rows: [
				["north", 12],
				["south", 18],
			],
			row_count: 2,
			execution_ms: 1,
			freshness: { source: "lake", observed_at: new Date().toISOString(), window_s: null },
			query_ref: "q_chart",
		};
		expect(
			materializePanel(
				{ schema_version: 2, type: "table", title: "Auto", query_ref: result.query_ref },
				result,
			).panel,
		).toMatchObject({
			type: "bar",
			encoding: { x: "zone", y: "latency" },
		});
		const crowded = {
			...result,
			rows: Array.from({ length: 21 }, (_, index) => [`zone-${String(index)}`, index]),
			row_count: 21,
		};
		expect(
			materializePanel(
				{ schema_version: 2, type: "table", title: "Auto", query_ref: result.query_ref },
				crowded,
			).panel.type,
		).toBe("table");
	});

	it("generates Vega-Lite forecast data without renderer code", () => {
		const result = {
			schema_version: 1 as const,
			columns: [
				{ name: "bucket", type: "string" },
				{ name: "cpu", type: "number" },
			],
			rows: [
				["2026-07-12T00:00:00.000Z", 30],
				["2026-07-11T00:00:00.000Z", 20],
				["2026-07-10T00:00:00.000Z", 10],
			],
			row_count: 3,
			execution_ms: 1,
			freshness: { source: "lake", observed_at: new Date().toISOString(), window_s: null },
			query_ref: "q_forecast",
		};
		const output = materializePanel(
			{
				schema_version: 2,
				type: "line",
				title: "CPU trend",
				query_ref: "q_forecast",
				encoding: { x: "bucket", y: "cpu" },
				forecast: { strategy: "linear", horizon: 2, confidence: "high" },
			},
			result,
		);
		expect(output.render).toMatchObject({
			renderer: "vega-lite",
			forecast_strategy: "linear",
		});
		const data = output.render.spec?.["data"] as { values: Record<string, unknown>[] };
		expect(data.values).toHaveLength(5);
		expect(data.values[0]?.["bucket"]).toBe("2026-07-10T00:00:00.000Z");
		expect(data.values.at(-1)).toMatchObject({ __series: "forecast" });
		expect(Date.parse(String(data.values.at(-1)?.["bucket"]))).toBeGreaterThan(
			Date.parse("2026-07-12T00:00:00.000Z"),
		);

		const numeric = materializePanel(
			{
				schema_version: 2,
				type: "line",
				title: "Numeric trend",
				query_ref: "q_numeric",
				encoding: { x: "step", y: "value" },
				forecast: { strategy: "drift", horizon: 1 },
			},
			{
				...result,
				columns: [
					{ name: "step", type: "number" },
					{ name: "value", type: "number" },
				],
				rows: [
					[3, 30],
					[1, 10],
					[2, 20],
				],
				query_ref: "q_numeric",
			},
		);
		const layers = numeric.render.spec?.["layer"] as {
			encoding: { x: { type: string } };
		}[];
		expect(layers.map((layer) => layer.encoding.x.type)).toEqual(["quantitative", "quantitative"]);
	});
});
