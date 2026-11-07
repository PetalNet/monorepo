/**
 * A small parser for JSON that crosses the HTTP boundary. Each parser either returns the typed
 * value or fails with a message that names the offending path, so a 400 says "doc.elements[2].size:
 * expected a number" instead of "bad request".
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type Parser<T> = (input: unknown, path: string) => Parsed<T>;
export type Infer<P> = P extends Parser<infer T> ? T : never;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (path: string, message: string): Parsed<never> => ({
	ok: false,
	error: path ? `${path}: ${message}` : message,
});

export function parse<T>(parser: Parser<T>, input: unknown, path = ""): Parsed<T> {
	return parser(input, path);
}

export const string =
	(options: { max?: number; min?: number; pattern?: RegExp } = {}): Parser<string> =>
	(input, path) => {
		if (typeof input !== "string") {
			return fail(path, "expected a string");
		}

		if (options.min !== undefined && input.length < options.min) {
			return fail(
				path,
				options.min === 1
					? "must not be empty"
					: `must be at least ${String(options.min)} characters`,
			);
		}

		if (options.max !== undefined && input.length > options.max) {
			return fail(path, `must be at most ${String(options.max)} characters`);
		}

		if (options.pattern && !options.pattern.test(input)) {
			return fail(path, `must match ${options.pattern.source}`);
		}

		return ok(input);
	};

export const number =
	(options: { min?: number; max?: number; integer?: boolean } = {}): Parser<number> =>
	(input, path) => {
		if (typeof input !== "number" || !Number.isFinite(input)) {
			return fail(path, "expected a number");
		}

		if (options.integer && !Number.isInteger(input)) {
			return fail(path, "expected a whole number");
		}

		if (options.min !== undefined && input < options.min) {
			return fail(path, `must be at least ${String(options.min)}`);
		}

		if (options.max !== undefined && input > options.max) {
			return fail(path, `must be at most ${String(options.max)}`);
		}

		return ok(input);
	};

export const boolean: Parser<boolean> = (input, path) =>
	typeof input === "boolean" ? ok(input) : fail(path, "expected true or false");

export const oneOf =
	<const T extends readonly (string | number)[]>(...values: T): Parser<T[number]> =>
	(input, path) =>
		values.includes(input as T[number])
			? ok(input as T[number])
			: fail(path, `expected one of ${values.map((value) => JSON.stringify(value)).join(", ")}`);

export const nullable =
	<T>(parser: Parser<T>): Parser<T | null> =>
	(input, path) =>
		input === null ? ok(null) : parser(input, path);

export const array =
	<T>(item: Parser<T>, options: { max?: number } = {}): Parser<T[]> =>
	(input, path) => {
		if (!Array.isArray(input)) {
			return fail(path, "expected a list");
		}

		if (options.max !== undefined && input.length > options.max) {
			return fail(path, `at most ${String(options.max)} items`);
		}

		const values: T[] = [];

		for (const [index, value] of input.entries()) {
			const parsed = item(value, `${path}[${String(index)}]`);

			if (!parsed.ok) {
				return parsed;
			}

			values.push(parsed.value);
		}

		return ok(values);
	};

export const record =
	<T>(value: Parser<T>, options: { maxKeys?: number } = {}): Parser<Record<string, T>> =>
	(input, path) => {
		if (!isPlainObject(input)) {
			return fail(path, "expected an object");
		}

		const entries = Object.entries(input);

		if (options.maxKeys !== undefined && entries.length > options.maxKeys) {
			return fail(path, `at most ${String(options.maxKeys)} keys`);
		}

		const out: Record<string, T> = {};

		for (const [key, item] of entries) {
			const parsed = value(item, path ? `${path}.${key}` : key);

			if (!parsed.ok) {
				return parsed;
			}

			out[key] = parsed.value;
		}

		return ok(out);
	};

type Shape = Record<string, Parser<unknown>>;
type OptionalKeys<S extends Shape> = {
	[K in keyof S]: S[K] extends Optional<unknown> ? K : never;
}[keyof S];
type ObjectOf<S extends Shape> = {
	[K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & { [K in OptionalKeys<S>]?: Infer<S[K]> };

interface Optional<T> extends Parser<T | undefined> {
	optional: true;
}

/** A key that may be absent; present keys still have to parse. */
export function optional<T>(parser: Parser<T>): Optional<T> {
	const wrapped: Parser<T | undefined> = (input, path) =>
		input === undefined ? ok(undefined) : parser(input, path);

	return Object.assign(wrapped, { optional: true as const });
}

/** Known keys are parsed; unknown keys are dropped so stored documents stay canonical. */
export const object =
	<S extends Shape>(shape: S): Parser<ObjectOf<S>> =>
	(input, path) => {
		if (!isPlainObject(input)) {
			return fail(path, "expected an object");
		}

		const out: Record<string, unknown> = {};

		for (const [key, parser] of Object.entries(shape)) {
			const parsed = parser(input[key], path ? `${path}.${key}` : key);

			if (!parsed.ok) {
				return parsed;
			}

			if (parsed.value !== undefined) {
				out[key] = parsed.value;
			}
		}

		return ok(out as ObjectOf<S>);
	};

/** Picks the parser for an object by its discriminant, e.g. `kind`. */
export const tagged =
	<M extends Record<string, Parser<unknown>>>(key: string, parsers: M): Parser<Infer<M[keyof M]>> =>
	(input, path) => {
		if (!isPlainObject(input)) {
			return fail(path, "expected an object");
		}

		const tag = input[key];
		const parser = typeof tag === "string" ? parsers[tag] : undefined;

		if (!parser) {
			return fail(
				path ? `${path}.${key}` : key,
				`expected one of ${Object.keys(parsers)
					.map((name) => JSON.stringify(name))
					.join(", ")}`,
			);
		}

		return parser(input, path) as Parsed<Infer<M[keyof M]>>;
	};

export function refine<T>(parser: Parser<T>, check: (value: T) => string | null): Parser<T> {
	return (input, path) => {
		const parsed = parser(input, path);

		if (!parsed.ok) {
			return parsed;
		}

		const problem = check(parsed.value);

		return problem === null ? parsed : fail(path, problem);
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
