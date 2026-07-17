import attention from "../../../docs/contracts/schemas/attention-item.schema.json";
import busFrame from "../../../docs/contracts/schemas/bus-frame.schema.json";
import emission from "../../../docs/contracts/schemas/emission.schema.json";
import opCall from "../../../docs/contracts/schemas/op-call.schema.json";
import opResult from "../../../docs/contracts/schemas/op-result.schema.json";
import queryRequest from "../../../docs/contracts/schemas/query-request.schema.json";
import queryResult from "../../../docs/contracts/schemas/query-result.schema.json";

const json = (schema: object) => ({ "application/json": { schema } });

/** Generated contract document assembled from the canonical language-neutral JSON Schemas. */
export const openApiDocument = {
	openapi: "3.1.0",
	info: { title: "Lab Console unified API", version: "1.0.0" },
	servers: [{ url: "/api/v1" }],
	paths: {
		"/query": {
			post: {
				operationId: "runStructuredQuery",
				requestBody: { required: true, content: json(queryRequest) },
				responses: { "200": { description: "Scoped query result", content: json(queryResult) } },
			},
		},
		"/op": {
			post: {
				operationId: "executeNamedOperation",
				requestBody: { required: true, content: json(opCall) },
				responses: { "200": { description: "Operation receipt", content: json(opResult) } },
			},
		},
		"/attention": { get: { operationId: "readAttention", responses: { "200": { description: "Attention envelope" } } } },
		"/bus/emit": {
			post: {
				operationId: "emitBusEvent",
				requestBody: { required: true, content: json(emission) },
				responses: { "200": { description: "Emission acknowledgement" } },
			},
		},
		"/mcp": { post: { operationId: "consoleMcp", responses: { "200": { description: "MCP JSON-RPC response" } } } },
	},
	components: {
		schemas: { AttentionItem: attention, BusFrame: busFrame, Emission: emission, OpCall: opCall, OpResult: opResult, QueryRequest: queryRequest, QueryResult: queryResult },
	},
} as const;
