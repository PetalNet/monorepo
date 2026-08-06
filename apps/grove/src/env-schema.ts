import { Schema } from "effect";

export function optionalWhenBuilding<S extends Schema.Top>(building: boolean, schema: S): S;
export function optionalWhenBuilding<S extends Schema.Top>(building: boolean, schema: S) {
	return building ? Schema.optional(schema) : schema;
}

const parseUrl = (value: string) => {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
};
const safeUrl = (value: string, dev: boolean, originOnly: boolean) => {
	const url = parseUrl(value);
	if (!url || url.username || url.password || url.search || url.hash) return false;
	if (originOnly && url.pathname !== "/") return false;
	if (url.protocol === "https:") return true;
	return (
		dev &&
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
	);
};
const authUrl = (dev: boolean) =>
	Schema.NonEmptyString.check(
		Schema.makeFilter((value) => safeUrl(value, dev, true) || "expected a canonical HTTPS origin"),
	);
const oidcIssuer = (dev: boolean) =>
	Schema.NonEmptyString.check(
		Schema.makeFilter((value) => safeUrl(value, dev, false) || "expected a canonical HTTPS issuer"),
	);

export const authUrlSchema = (building: boolean, dev: boolean) =>
	optionalWhenBuilding(building, authUrl(dev));

export const oidcIssuerSchema = (building: boolean, dev: boolean) =>
	optionalWhenBuilding(building, oidcIssuer(dev));
