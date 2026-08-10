import { building, dev } from "$app/env";
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { authUrlSchema, mcpResourceSchema, oidcIssuerSchema } from "../src/env";

const accepts = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
	Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));

describe("Grove environment", () => {
	it("requires a canonical auth URL", () => {
		const value = "https://grove.example.com";

		expect(accepts(authUrlSchema, undefined)).toBe(building);
		expect(accepts(authUrlSchema, "http://grove.example.com")).toBe(false);
		expect(Schema.decodeUnknownSync(authUrlSchema)(value)).toBe(value);
		expect(accepts(authUrlSchema, "https://grove.example.com/path")).toBe(false);
		expect(accepts(authUrlSchema, "https://user@grove.example.com")).toBe(false);
		expect(accepts(authUrlSchema, "https://grove.example.com?callback=evil")).toBe(false);
		expect(accepts(authUrlSchema, "not a URL")).toBe(false);
	});

	it("only allows HTTP on localhost in development", () => {
		expect(accepts(authUrlSchema, "http://localhost:5173")).toBe(dev);
		expect(accepts(authUrlSchema, "http://example.com")).toBe(false);
	});

	it("requires a safe OIDC issuer", () => {
		expect(accepts(oidcIssuerSchema, "http://identity.example.com")).toBe(false);
		expect(accepts(oidcIssuerSchema, "https://identity.example.com/realm/grove")).toBe(true);
		expect(accepts(oidcIssuerSchema, "http://localhost:8080/realms/grove")).toBe(dev);
		expect(accepts(oidcIssuerSchema, "https://identity.example.com/realm/grove#other")).toBe(false);
	});

	it("requires an HTTPS origin for the canonical MCP resource", () => {
		expect(accepts(mcpResourceSchema, "https://grove.example")).toBe(true);
		expect(accepts(mcpResourceSchema, "http://grove.example")).toBe(false);
		expect(accepts(mcpResourceSchema, "https://grove.example/mcp")).toBe(false);
		expect(accepts(mcpResourceSchema, "http://localhost:5173")).toBe(dev);
	});
});
