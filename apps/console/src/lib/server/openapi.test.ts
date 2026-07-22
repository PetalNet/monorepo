import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OpCallSchema, QueryRequestSchema } from "./domain/api-schema";
import { buildOpenApiDocument } from "./openapi";

// The document is derived from whatever routes the caller passes (in production, the console API's
// own `api.routes` — the exact table the runtime dispatches). These fixtures exercise the
// derivation itself: schema linking, path-param rewriting, and the unknown-route fallback.
const routes = [
	{ method: "POST", pattern: "/api/v1/op" },
	{ method: "GET", pattern: "/api/v1/dashboards/:dashboardId" },
] as const;

describe("schema-derived OpenAPI", () => {
	it("renders component schemas directly from the domain Effect schemas", () => {
		const doc = buildOpenApiDocument(routes);
		expect(doc.components.schemas["OpCall"]).toEqual(
			Schema.toJsonSchemaDocument(OpCallSchema).schema,
		);
		expect(doc.components.schemas["QueryRequest"]).toEqual(
			Schema.toJsonSchemaDocument(QueryRequestSchema).schema,
		);
	});

	it("links a known operation's body and response to generated components", () => {
		const doc = buildOpenApiDocument(routes);
		expect(doc.paths["/op"].post).toMatchObject({
			requestBody: {
				content: { "application/json": { schema: { $ref: "#/components/schemas/OpCall" } } },
			},
			responses: {
				"200": {
					content: { "application/json": { schema: { $ref: "#/components/schemas/OpResult" } } },
				},
			},
		});
	});

	it("documents exactly the given routes, rewriting :params to {params}", () => {
		const doc = buildOpenApiDocument(routes);
		expect(doc.paths["/dashboards/{dashboardId}"].get).toBeDefined();
		// Nothing invented, nothing dropped: the surface is precisely what was handed in.
		expect(Object.keys(doc.paths).toSorted()).toEqual(["/dashboards/{dashboardId}", "/op"]);
	});
});
