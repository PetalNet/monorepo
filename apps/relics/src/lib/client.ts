import { Schema, Option } from "effect";
const Failure = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

export async function command(path: string, input: unknown) {
	const response = await fetch(`/api/v1/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body: unknown = await response.json();

	if (!response.ok) {
		const parsed = Schema.decodeUnknownOption(Failure)(body);

		throw new Error(
			Option.isSome(parsed)
				? parsed.value.error.message
				: "The request could not be completed. Please try again.",
		);
	}

	return body;
}
