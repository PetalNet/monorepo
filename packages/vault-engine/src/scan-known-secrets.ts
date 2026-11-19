#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];

	if (Array.isArray(value)) return value.flatMap(strings);

	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
	}

	return [];
}

function secretValues(value: unknown): string[] {
	if (typeof value === "string") return [value];

	if (value !== null && typeof value === "object")
		return Object.values(value).flatMap(secretValues);

	return [];
}

function candidates(value: string): string[] {
	try {
		// Structured credentials contain standalone braces; those are syntax, not secret fragments.
		return [value, ...secretValues(JSON.parse(value))];
	} catch {
		return [
			value,
			...value
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => !/^[{}\[\],\s]*$/.test(line)),
		];
	}
}

async function scan(manifestPath: string) {
	const dump: unknown = JSON.parse(await text(process.stdin));

	if (dump === null || typeof dump !== "object" || Array.isArray(dump)) throw new Error();

	const values: unknown[] = Object.values(dump);

	if (values.length === 0 || !values.every((value) => typeof value === "string")) throw new Error();

	const secrets = new Set(values.flatMap(candidates).filter(Boolean));

	if (secrets.size === 0) throw new Error();

	const containsSecret = (text: string) => [...secrets].some((secret) => text.includes(secret));
	const manifest = await readFile(manifestPath, "utf8");

	if (containsSecret(manifest)) return false;

	let entries = 0;

	for (const line of manifest.split("\n")) {
		if (line.trim() === "") continue;

		entries++;
		const entry: unknown = JSON.parse(line);

		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error();

		if (strings(entry).some(containsSecret)) return false;

		if (!("type" in entry)) throw new Error();

		if (entry.type === "document") {
			if (!("file" in entry) || typeof entry.file !== "string" || entry.file === "")
				throw new Error();

			if (containsSecret(await readFile(entry.file, "utf8"))) return false;
		} else if (entry.type !== "capture") {
			throw new Error();
		}
	}

	if (entries === 0) throw new Error();

	return true;
}

const manifestPath = process.argv[2];

if (process.argv.length !== 3 || manifestPath === undefined) {
	console.error("usage: scan-known-secrets.ts <manifest.jsonl> (vault dump on stdin)");
	process.exitCode = 2;
} else {
	try {
		if (!(await scan(manifestPath))) {
			console.error("known-secret scan refused the manifest");
			process.exitCode = 1;
		}
	} catch {
		console.error("known-secret scan failed: invalid or unreadable input");
		process.exitCode = 1;
	}
}
