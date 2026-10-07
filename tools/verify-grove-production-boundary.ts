#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = path.resolve(root, "apps/grove/build");
const forbidden = [
	"Browser log requests must not exceed 16 KiB",
	"Development MCP client credentials are configured for explicit Agent enrollment.",
	"Redirect alias into the real auto-approved Authorization Code",
	"operatorCanChooseOrImpersonateAgentSubject",
	"window.unhandledrejection",
];

const files = async (directory: string): Promise<string[]> => {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const filePath = path.resolve(directory, entry.name);
				return entry.isDirectory() ? files(filePath) : [filePath];
			}),
		)
	).flat();
};

const leaks = [];
const candidates = (await files(build)).filter((filePath) =>
	[".js", ".map"].includes(path.extname(filePath)),
);
const artifacts = await Promise.all(
	candidates.map(async (filePath) => ({
		content: await readFile(filePath, "utf8"),
		path: filePath,
	})),
);
for (const { content, path: filePath } of artifacts) {
	for (const marker of forbidden) {
		if (content.includes(marker)) leaks.push({ marker, path: filePath.slice(root.length) });
	}
}

if (leaks.length > 0)
	throw new Error(
		`Grove production build contains development control-plane implementation:\n${leaks
			.map(({ marker, path: filePath }) => `- ${filePath}: ${marker}`)
			.join("\n")}`,
	);

console.log("Grove production build excludes development control-plane implementation");
