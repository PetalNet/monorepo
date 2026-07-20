import { Schema } from "effect";

import { API_ROUTE_REGISTRY } from "./domain/api-routes";
import { apiSchema } from "./domain/api-schema";

type ComponentName = keyof typeof apiSchema.components;
type HttpMethod = (typeof apiSchema.operations)[number]["method"];

const schemaRef = (name: ComponentName) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: ComponentName) => ({ "application/json": { schema: schemaRef(name) } });

function generatePaths() {
	const paths: Record<string, Partial<Record<HttpMethod, object>>> = {};
	for (const [routeMethod, registeredPath] of API_ROUTE_REGISTRY) {
		const method = routeMethod.toLowerCase() as HttpMethod;
		const routePath = registeredPath.slice("/api/v1".length);
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

/** OpenAPI is generated from the Effect schemas shared by the domain API registry. */
export const openApiDocument = {
	openapi: "3.1.0",
	info: { title: "Lab Console unified API", version: "1.0.0" },
	servers: [{ url: "/api/v1" }],
	paths: generatePaths(),
	components: {
		schemas: Object.fromEntries(
			Object.entries(apiSchema.components).map(([name, schema]) => [
				name,
				Schema.toJsonSchemaDocument(schema).schema,
			]),
		),
	},
} as const;
