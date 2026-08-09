import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { authUrlSchema } from "../src/env";

const accepts = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
	Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));

describe("Grove environment", () => {
	it("requires a canonical HTTPS auth URL in production", () => {
		const production = authUrlSchema(false, false);

		expect(accepts(production, undefined)).toBe(false);
		expect(accepts(production, "http://grove.example.com")).toBe(false);
		expect(accepts(production, "https://grove.example.com")).toBe(true);
	});

	it("allows an optional HTTP auth URL in local development and build", () => {
		expect(accepts(authUrlSchema(false, true), "http://localhost:5173")).toBe(true);
		expect(accepts(authUrlSchema(true, false), undefined)).toBe(true);
	});
});
