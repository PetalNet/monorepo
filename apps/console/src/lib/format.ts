/** Render an unknown transport value without relying on Object's unhelpful default string form. */
export function formatUnknown(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
		return String(value);
	return JSON.stringify(value) ?? "";
}
