import { Schema } from "effect";

export function optionalWhenBuilding<S extends Schema.Top>(building: boolean, schema: S): S;
export function optionalWhenBuilding<S extends Schema.Top>(building: boolean, schema: S) {
	return building ? Schema.optional(schema) : schema;
}

const canonicalAuthUrl = Schema.NonEmptyString.check(Schema.isPattern(/^https:\/\//));

export const authUrlSchema = (building: boolean, dev: boolean) =>
	building || dev ? Schema.optional(Schema.NonEmptyString) : canonicalAuthUrl;
