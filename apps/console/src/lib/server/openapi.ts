import { Schema } from "effect";

import { apiSchema } from "./domain/api-schema";

type ComponentName = keyof typeof apiSchema.components;
type HttpMethod = (typeof apiSchema.operations)[number]["method"];

/** Method + pattern of one registered REST route, e.g. `{ method: "POST", pattern: "/api/v1/op" }`. */
export interface ApiRoute {
	readonly method: string;
	readonly pattern: string;
}

const schemaRef = (name: ComponentName) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: ComponentName) => ({ "application/json": { schema: schemaRef(name) } });

function generatePaths(routes: readonly ApiRoute[]) {
	const paths: Record<string, Partial<Record<HttpMethod, object>>> = {};
	for (const { method: routeMethod, pattern } of routes) {
		const method = routeMethod.toLowerCase() as HttpMethod;
		const routePath = pattern.slice("/api/v1".length);
		const path = routePath.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
		const operation = apiSchema.operations.find(
			(candidate) => candidate.method === method && candidate.path === routePath,
		);
		const item = paths[path] ?? {};
		item[method] = operation
			? {
					operationId: operation.operationId,
					...(method === "post" && "request" in operation
						? { requestBody: { required: true, content: json(operation.request) } }
						: {}),
					responses: {
						"200": { description: operation.description, content: json(operation.response) },
					},
				}
			: {
					operationId: `${method}${path.replaceAll(/[^A-Za-z0-9]+/g, "_")}`,
					responses: { "200": { description: "Successful response" } },
				};
		paths[path] = item;
	}
	return paths;
}

/**
 * OpenAPI generated from the console API's own registered routes — the exact RouteDef list the
 * runtime dispatches, handed in as `api.routes` — the way FastAPI derives its schema from the live
 * app. There is no separately maintained route registry to drift against the real surface; the
 * request/response bodies still come from the shared Effect schemas in `api-schema`.
 */
export function buildOpenApiDocument(routes: readonly ApiRoute[]) {
	return {
		openapi: "3.1.0",
		info: { title: "Lab Console unified API", version: "1.0.0" },
		servers: [{ url: "/api/v1" }],
		paths: generatePaths(routes),
		components: {
			schemas: Object.fromEntries(
				Object.entries(apiSchema.components).map(([name, schema]) => [
					name,
					Schema.toJsonSchemaDocument(schema).schema,
				]),
			),
		},
	} as const;
}
