import { Schema } from "effect";

import type { ApiOperation } from "./operation.js";

interface OpenApiConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly basePath: string;
	readonly operations: readonly ApiOperation<R>[];
}

const schemaJson = (schema: Schema.Constraint): object =>
	Schema.toJsonSchemaDocument(schema).schema;

const openApiPath = (path: string): string => path.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");

interface ObjectSchema {
	readonly properties?: Readonly<Record<string, object>>;
	readonly required?: readonly string[];
}

const withoutProperties = (schema: object, names: ReadonlySet<string>): object => {
	const { properties, required } = schema as ObjectSchema;
	if (!properties) return schema;
	return {
		...schema,
		properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !names.has(name))),
		...(required ? { required: required.filter((name) => !names.has(name)) } : {}),
	};
};

export function createOpenApi<R>(config: OpenApiConfig<R>) {
	const paths: Record<string, Record<string, object>> = {};
	for (const operation of config.operations) {
		const path = openApiPath(operation.path);
		const inputSchema = schemaJson(operation.input);
		const inputProperties = (inputSchema as ObjectSchema).properties;
		const pathNames = new Set(
			[...operation.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => name!),
		);
		const pathParameters = [...pathNames].map((name) => ({
			name,
			in: "path",
			required: true,
			schema: inputProperties?.[name] ?? { type: "string" },
		}));
		paths[path] ??= {};
		paths[path][operation.method.toLowerCase()] = {
			operationId: operation.name,
			description: operation.description,
			...(pathParameters.length > 0 ? { parameters: pathParameters } : {}),
			...(operation.body
				? {
						requestBody: {
							required: true,
							content: {
								"application/json": { schema: withoutProperties(inputSchema, pathNames) },
							},
						},
					}
				: {}),
			responses: {
				"200": {
					description: "Successful response",
					content: { "application/json": { schema: schemaJson(operation.output) } },
				},
				"400": { description: "Invalid input" },
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: { title: config.title, version: config.version },
		servers: [{ url: config.basePath }],
		paths,
	};
}
