import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { authUrlSchema, optionalWhenBuilding } from "../src/env-schema";

const accepts = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
	Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));

describe("Grove environment schemas", () => {
	it("allows runtime-only values to be absent only while building", () => {
		expect(accepts(optionalWhenBuilding(true, Schema.NonEmptyString), undefined)).toBe(true);
		expect(accepts(optionalWhenBuilding(false, Schema.NonEmptyString), undefined)).toBe(false);
	});

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
