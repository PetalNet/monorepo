import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OpCallSchema, QueryRequestSchema } from "./domain/api-schema";
import { openApiDocument } from "./openapi";

describe("schema-derived OpenAPI", () => {
	it("renders component schemas directly from the domain Effect schemas", () => {
		expect(openApiDocument.components.schemas["OpCall"]).toEqual(
			Schema.toJsonSchemaDocument(OpCallSchema).schema,
		);
		expect(openApiDocument.components.schemas["QueryRequest"]).toEqual(
			Schema.toJsonSchemaDocument(QueryRequestSchema).schema,
		);
	});

	it("links every operation body and response to generated components", () => {
		expect(openApiDocument.paths["/op"].post).toMatchObject({
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

	it("covers the shared route registry and documents the real emit path", () => {
		expect(Object.keys(openApiDocument.paths).length).toBeGreaterThan(60);
		expect(openApiDocument.paths["/emit"].post).toBeDefined();
		expect(openApiDocument.paths["/bus/emit"]).toBeUndefined();
		expect(openApiDocument.paths["/dashboards/{dashboardId}"].get).toBeDefined();
	});
});
