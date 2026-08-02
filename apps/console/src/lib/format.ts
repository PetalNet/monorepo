/** Render an unknown transport value without relying on Object's unhelpful default string form. */
export function formatUnknown(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
		return String(value);
	return JSON.stringify(value);
}

/** Narrow a value that is required by an already-validated domain invariant. */
export function required<T>(value: T | null | undefined, label = "value"): T {
	if (value === null || value === undefined) throw new Error(`Missing required ${label}`);
	return value;
}

/** Copy a record without transport-only keys. */
export function omitKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
	const omitted = new Set(keys);
	return Object.fromEntries(Object.entries(record).filter(([key]) => !omitted.has(key)));
}
