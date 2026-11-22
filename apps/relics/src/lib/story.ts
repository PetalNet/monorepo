const traits = [
	"Excellent at doing very little.",
	"Thinks every leaf is a tiny umbrella.",
	"Always saves room for a second snack.",
	"A surprisingly good listener.",
	"Has a soft spot for rainy days.",
	"Practicing the art of the afternoon nap.",
	"Likes to take the scenic route.",
	"Quietly rooting for you.",
];

export function traitFor(id: string) {
	const hash = Array.from(id).reduce(
		(value, letter) => (value * 31 + (letter.codePointAt(0) ?? 0)) >>> 0,
		0,
	);

	return traits[hash % traits.length];
}

export function birthdayLabel(timestamp: number) {
	return new Intl.DateTimeFormat("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(timestamp);
}
