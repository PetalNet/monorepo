// Server-side access to the canonical contracts directory. The deterministic draft-2020-12
// validator itself lives in `$lib/contracts/json-schema.ts` (browser-safe, shared with the client
// op catalog); this module adds the bundled-contract loading only the server needs.
export { validateJsonSchema, type JsonSchema } from "../../contracts/json-schema.ts";
import type { JsonSchema } from "../../contracts/json-schema.ts";

// The contracts are compiled into the bundle (the built server has no source tree on disk).
export const CONTRACTS_DIR = new URL("contract://console/");
const bundledContracts = import.meta.glob<JsonSchema>("../../../../docs/contracts/**/*.json", {
	eager: true,
	import: "default",
});
const contractsByPath = new Map<string, JsonSchema>(
	Object.entries(bundledContracts).map(([path, schema]) => [
		path.replace(/^.*\/docs\/contracts\//, ""),
		schema,
	]),
);
export function readSchema(url: URL): JsonSchema {
	const key = url.pathname.replace(/^\/+/, "");
	const schema = contractsByPath.get(key);
	if (!schema) throw new Error(`unknown contract schema: ${key}`);
	return schema;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
