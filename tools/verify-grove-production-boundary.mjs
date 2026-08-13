#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = resolve(root, "apps/grove/build");
const forbidden = [
	"Browser log requests must not exceed 16 KiB",
	"Development MCP client credentials are configured for explicit Agent enrollment.",
	"Redirect alias into the real auto-approved Authorization Code",
	"operatorCanChooseOrImpersonateAgentSubject",
	"window.unhandledrejection",
];

const files = async (directory) => {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map((entry) => {
				const path = resolve(directory, entry.name);
				return entry.isDirectory() ? files(path) : [path];
			}),
		)
	).flat();
};

const leaks = [];
for (const path of await files(build)) {
	if (![".js", ".map"].includes(extname(path))) continue;
	const content = await readFile(path, "utf8");
	for (const marker of forbidden) {
		if (content.includes(marker)) leaks.push({ marker, path: path.slice(root.length) });
	}
}

if (leaks.length > 0)
	throw new Error(
		`Grove production build contains development control-plane implementation:\n${leaks
			.map(({ marker, path }) => `- ${path}: ${marker}`)
			.join("\n")}`,
	);

console.log("Grove production build excludes development control-plane implementation");
