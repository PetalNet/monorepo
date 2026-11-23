const kinds = [
	"human",
	"task-brief",
	"relay",
	"quoted",
	"voice-wrapper",
	"reminder",
	"automated-notification",
	"unknown",
] as const;

export type MessageSource = (typeof kinds)[number];

export function parseMessageSource(value: string): MessageSource | undefined {
	return kinds.find((kind) => kind === value);
}

export function tagMessage(source: MessageSource, text: string) {
	return `[message-source: ${source}]\n${text}`;
}

export function messageSource(text: string, fallback: MessageSource): MessageSource {
	const start = text.trimStart();
	const tag = /^\[message-source: ([a-z-]+)\](?:\r?\n|$)/u.exec(start)?.[1];
	const tagged = tag === undefined ? undefined : parseMessageSource(tag);

	if (tagged && tagged !== "human") {
		return tagged;
	}
	if (
		/^\[(?:handback NAG|promise-ledger)\]|^Not done, not blocked, not handed back:/u.test(start)
	) {
		return "reminder";
	}
	if (
		/^\[Voice head(?: turn\.| warm-up\.|:)|^\[Local time: [^\n]+\]\n(?:\[[^\n]*cut you off[^\n]*\]\n)?The speaker says: /u.test(
			start,
		)
	) {
		return "voice-wrapper";
	}
	if (start.startsWith("<task-notification>")) {
		return "automated-notification";
	}
	return fallback;
}
