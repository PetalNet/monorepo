// Deterministic JSON-schema validation over self-contained schema documents (the op catalog's
// inline `args`). Browser-safe: no filesystem, no server-only imports — `$lib/api/ops` runs this in
// the client bundle. `$ref` resolution is limited to in-document `#/...` pointers; the catalog is
// fully dereferenced (Phase 4), so file-level refs are a contract error.
import { ISO_DATETIME_OFFSET_RE, UUID_RE } from "./schema-conventions.ts";

export type JsonSchema = Record<string, unknown>;

function schemaAtPointer(schema: JsonSchema, fragment: string): JsonSchema | null {
	let value: unknown = schema;
	for (const raw of fragment.replace(/^#\/?/, "").split("/").filter(Boolean)) {
		const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		value = (value as Record<string, unknown>)[part];
	}
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : null;
}

function schemaType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value === "number" ? "number" : typeof value;
}

/** The catalog uses a deliberately small, deterministic draft-2020-12 subset. */
export function validateJsonSchema(
	value: unknown,
	schema: JsonSchema,
	path = "args",
	root: JsonSchema = schema,
): string | null {
	if (typeof schema["$ref"] === "string") {
		const ref = schema["$ref"];
		const target = ref.startsWith("#") ? schemaAtPointer(root, ref) : null;
		return target
			? validateJsonSchema(value, target, path, root)
			: `${path}: unresolved schema reference`;
	}
	for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		const errors = branches.map((branch) =>
			branch && typeof branch === "object"
				? validateJsonSchema(value, branch as JsonSchema, path, root)
				: `${path}: invalid schema`,
		);
		if (keyword === "allOf") {
			const failure = errors.find(Boolean);
			if (failure) return failure;
		} else if (keyword === "anyOf" && errors.every(Boolean)) return errors[0] ?? `${path}: invalid`;
		else if (keyword === "oneOf" && errors.filter((error) => !error).length !== 1)
			return `${path}: must match exactly one allowed shape`;
	}
	if (schema["if"] && typeof schema["if"] === "object") {
		const conditionMatches = !validateJsonSchema(value, schema["if"] as JsonSchema, path, root);
		const branch = conditionMatches ? schema["then"] : schema["else"];
		if (branch && typeof branch === "object") {
			const error = validateJsonSchema(value, branch as JsonSchema, path, root);
			if (error) return error;
		}
	}
	if (Object.hasOwn(schema, "const") && !Object.is(value, schema["const"]))
		return `${path}: must equal the required value`;
	if (Array.isArray(schema["enum"]) && !schema["enum"].some((item) => Object.is(item, value)))
		return `${path}: value is not allowed`;
	const allowed = Array.isArray(schema["type"])
		? schema["type"]
		: typeof schema["type"] === "string"
			? [schema["type"]]
			: [];
	const actual = schemaType(value);
	if (
		allowed.length &&
		!allowed.includes(actual) &&
		!(actual === "integer" && allowed.includes("number"))
	)
		return `${path}: expected ${allowed.join(" or ")}`;
	if (typeof value === "string") {
		if (typeof schema["minLength"] === "number" && value.length < schema["minLength"])
			return `${path}: string is too short`;
		if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"])
			return `${path}: string is too long`;
		if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"]).test(value))
			return `${path}: invalid format`;
		if (schema["format"] === "uuid" && !UUID_RE.test(value)) return `${path}: invalid UUID`;
		if (schema["format"] === "date-time" && !ISO_DATETIME_OFFSET_RE.test(value))
			return `${path}: invalid date-time`;
	}
	if (typeof value === "number") {
		if (typeof schema["minimum"] === "number" && value < schema["minimum"])
			return `${path}: below minimum`;
		if (typeof schema["maximum"] === "number" && value > schema["maximum"])
			return `${path}: above maximum`;
	}
	if (Array.isArray(value)) {
		if (typeof schema["minItems"] === "number" && value.length < schema["minItems"])
			return `${path}: too few items`;
		if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"])
			return `${path}: too many items`;
		if (
			schema["uniqueItems"] === true &&
			new Set(value.map((item) => JSON.stringify(item))).size !== value.length
		)
			return `${path}: items must be unique`;
		if (schema["items"] && typeof schema["items"] === "object")
			for (let index = 0; index < value.length; index += 1) {
				const error = validateJsonSchema(
					value[index],
					schema["items"] as JsonSchema,
					`${path}.${String(index)}`,
					root,
				);
				if (error) return error;
			}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (
			typeof schema["maxProperties"] === "number" &&
			Object.keys(record).length > schema["maxProperties"]
		)
			return `${path}: too many fields`;
		const requiredFields = Array.isArray(schema["required"]) ? schema["required"] : [];
		for (const key of requiredFields)
			if (typeof key === "string" && !Object.hasOwn(record, key)) return `${path}.${key}: required`;
		const properties =
			schema["properties"] && typeof schema["properties"] === "object"
				? (schema["properties"] as Record<string, JsonSchema>)
				: {};
		for (const [key, item] of Object.entries(record)) {
			if (Object.hasOwn(properties, key)) {
				const propertySchema = properties[key];
				const error = validateJsonSchema(item, propertySchema, `${path}.${key}`, root);
				if (error) return error;
			} else if (schema["additionalProperties"] === false) return `${path}.${key}: unknown field`;
		}
	}
	return null;
}
