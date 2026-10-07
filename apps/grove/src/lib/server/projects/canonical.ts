import { Effect, Schema } from "effect";

const normalize = (value: Schema.Json): Schema.Json => {
	if (Array.isArray(value)) {
		return value.map(normalize);
	}

	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, child]) => [key, normalize(child)]),
		);
	}

	return value;
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export const canonicalDigest = (value: unknown): Effect.Effect<string, Schema.SchemaError> =>
	Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
		Effect.flatMap((json) =>
			Effect.promise(() =>
				crypto.subtle
					.digest("SHA-256", new TextEncoder().encode(encodeJson(normalize(json))))
					.then((digest) => new Uint8Array(digest).toHex()),
			),
		),
	);
