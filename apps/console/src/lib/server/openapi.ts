import { Schema } from "effect";

import { apiSchema } from "./domain/api-schema";

type ComponentName = keyof typeof apiSchema.components;
type HttpMethod = (typeof apiSchema.operations)[number]["method"];

const schemaRef = (name: ComponentName) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: ComponentName) => ({ "application/json": { schema: schemaRef(name) } });

function generatePaths() {
	const paths: Record<string, Partial<Record<HttpMethod, object>>> = {};
	for (const operation of apiSchema.operations) {
		const item = paths[operation.path] ?? {};
		item[operation.method] = {
			operationId: operation.operationId,
			...(operation.method === "post"
				? { requestBody: { required: true, content: json(operation.request) } }
				: {}),
			responses: {
				"200": { description: operation.description, content: json(operation.response) },
			},
		};
		paths[operation.path] = item;
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
