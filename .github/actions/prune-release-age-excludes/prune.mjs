import { appendFile, readFile, writeFile } from "node:fs/promises";

import semver from "semver";
import { isScalar, isSeq, parseDocument } from "yaml";

const file = process.env.WORKSPACE_FILE ?? "pnpm-workspace.yaml";
const registry = new URL(process.env.REGISTRY ?? "https://registry.npmjs.org/");
const source = await readFile(file, "utf8");
const document = parseDocument(source);

if (document.errors.length > 0) {
	throw new Error(document.errors.map((error) => error.message).join("\n"));
}

// pnpm >=11 defaults to a one-day release age; Renovate's gate is independent.
const age = document.get("minimumReleaseAge") ?? 1440;

if (typeof age !== "number" || !Number.isFinite(age) || age < 0) {
	throw new Error("minimumReleaseAge must be a nonnegative number of minutes");
}

const excludes = document.get("minimumReleaseAgeExclude");

if (excludes !== undefined && !isSeq(excludes)) {
	throw new Error("minimumReleaseAgeExclude must be a sequence");
}

// Validate the whole list before fetching metadata or pruning any entries.
const entries = (excludes?.items ?? []).map((item, index) => {
	const entry = isScalar(item) ? item.value : undefined;
	const match =
		typeof entry === "string"
			? /^(?<name>(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(?<version>\d[^\s@]*)$/u.exec(entry)
			: null;

	if (!match || match[0] !== entry || !semver.valid(match.groups.version)) {
		throw new Error(
			`minimumReleaseAgeExclude[${index}] (${JSON.stringify(entry)}) must use an exact version, such as package@1.2.3 or @scope/package@1.2.3. Replace package-wide entries, patterns, ranges, and tags with exact versions.`,
		);
	}

	return { entry, ...match.groups };
});

const cutoff = Date.now() - age * 60_000;
const removed = [];
const names = [...new Set(entries.map(({ name }) => name))];
const metadata = new Map(
	await Promise.all(
		names.map(async (name) => {
			try {
				const url = new URL(encodeURIComponent(name), `${registry.href.replace(/\/$/u, "")}/`);
				const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}

				return [name, await response.json()];
			} catch {
				console.warn(`Keeping exceptions for ${name}: registry metadata unavailable`);

				return [name, null];
			}
		}),
	),
);

for (let index = entries.length - 1; index >= 0; index--) {
	const { entry, name, version } = entries[index];

	const timestamp = metadata.get(name)?.time?.[version];
	const published = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;

	// Registry publish times use canonical ISO dates; Date.parse alone normalizes invalid dates.
	if (!Number.isFinite(published) || new Date(published).toISOString() !== timestamp) {
		console.warn(`Keeping ${entry}: publish time unavailable`);

		continue;
	}

	if (published <= cutoff) {
		excludes.delete(index);
		removed.unshift(entry);
	}
}

if (removed.length > 0) {
	// Retain the key as [] when all exceptions age out, rather than a null YAML value.
	await writeFile(file, document.toString());
}

console.log(`Removed ${removed.length} release-age exceptions: ${JSON.stringify(removed)}`);

if (process.env.GITHUB_OUTPUT) {
	await appendFile(
		process.env.GITHUB_OUTPUT,
		`changed=${removed.length > 0}\nremoved=${JSON.stringify(removed)}\n`,
	);
}
