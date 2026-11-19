#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function strings(value) {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
	}
	return [];
}

async function scan(manifestPath) {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const dump = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (dump === null || typeof dump !== "object" || Array.isArray(dump)) throw new Error();
	const values = Object.values(dump);
	if (values.length === 0 || values.some((value) => typeof value !== "string")) throw new Error();
	const secrets = new Set(
		values
			.flatMap((value) => [value, ...value.split(/\r?\n/).map((line) => line.trim())])
			.filter(Boolean),
	);
	if (secrets.size === 0) throw new Error();

	const containsSecret = (text) => [...secrets].some((secret) => text.includes(secret));
	const manifest = await readFile(manifestPath, "utf8");
	if (containsSecret(manifest)) return false;
	let entries = 0;
	for (const line of manifest.split("\n")) {
		if (line.trim() === "") continue;
		entries++;
		const entry = JSON.parse(line);
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
		if (strings(entry).some(containsSecret)) return false;
		if (entry.type === "document") {
			if (typeof entry.file !== "string" || entry.file === "") throw new Error();
			if (containsSecret(await readFile(entry.file, "utf8"))) return false;
		} else if (entry.type !== "capture") {
			throw new Error();
		}
	}
	if (entries === 0) throw new Error();
	return true;
}

if (process.argv.length !== 3) {
	console.error("usage: scan-known-secrets.mjs <manifest.jsonl> (vault dump on stdin)");
	process.exitCode = 2;
} else {
	try {
		if (!(await scan(process.argv[2]))) {
			console.error("known-secret scan refused the manifest");
			process.exitCode = 1;
		}
	} catch {
		console.error("known-secret scan failed: invalid or unreadable input");
		process.exitCode = 1;
	}
}
