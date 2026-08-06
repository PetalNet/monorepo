import { createHash } from "node:crypto";

const normalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === "object") {
		if (Object.getPrototypeOf(value) !== Object.prototype)
			throw new TypeError("Canonical JSON only supports plain objects and arrays");
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, child]) => [key, normalize(child)]),
		);
	}
	if (
		value === undefined ||
		typeof value === "bigint" ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		(typeof value === "number" && !Number.isFinite(value))
	)
		throw new TypeError("Value is not representable in canonical JSON");
	return value;
};

export const canonicalJson = (value: unknown): string => {
	return JSON.stringify(normalize(value));
};
export const canonicalDigest = (value: unknown): string =>
	createHash("sha256").update(canonicalJson(value)).digest("hex");
