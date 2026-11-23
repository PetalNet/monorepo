import { parseArgs } from "node:util";

export const launchOptions = {
	for: { type: "string" },
	class: { type: "string" },
	"data-class": { type: "string" },
	kind: { type: "string" },
	tier: { type: "string" },
	"allow-superseded": { type: "boolean" },
	"not-vendor": { type: "string" },
	"allow-claude": { type: "boolean" },
	promise: { type: "string" },
	"source-kind": { type: "string" },
} as const;

export function routeCommand(args: string[]) {
	const { tokens } = parseArgs({
		args,
		options: launchOptions,
		allowPositionals: true,
		strict: false,
		tokens: true,
	});

	return tokens.find((token) => token.kind === "positional");
}
