// New services and web apps in this repo are built on packages/effect-sveltekit and packages/effect-api.
// This check scans the tracked files and fails on a Python project, a Python file, or an apps/* package
// that is neither built on them nor listed in allowlist.json. The allowlist holds the existing exceptions.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Exception {
	readonly path: string;
	readonly reason: string;
}

const BUILT_ON = ["@petalnet/effect-sveltekit", "@petalnet/effect-api"];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

const covers = (entry: string, file: string) => file === entry || file.startsWith(`${entry}/`);

export const isBuiltOnEffect = (manifest: string) => {
	const parsed = JSON.parse(manifest) as Record<string, Record<string, string> | undefined>;

	return DEP_FIELDS.some((field) => BUILT_ON.some((name) => parsed[field]?.[name] !== undefined));
};

/**
 * Violations among `files`; `read` returns a tracked file's text. Pure, so tests can feed it a fake
 * tree.
 */
export function violations(
	files: readonly string[],
	allowlist: readonly Exception[],
	read: (file: string) => string,
) {
	const allowed = (file: string) => allowlist.some((entry) => covers(entry.path, file));
	const problems: string[] = [];

	for (const file of files) {
		if (allowed(file)) {
			continue;
		}

		if (/(?:^|\/)pyproject\.toml$/u.test(file) || file.endsWith(".py")) {
			problems.push(`${file}: Python service or script`);
		} else if (/^apps\/[^/]+\/package\.json$/u.test(file) && !isBuiltOnEffect(read(file))) {
			problems.push(`${file}: app without @petalnet/effect-sveltekit or @petalnet/effect-api`);
		}
	}

	for (const entry of allowlist) {
		if (!files.some((file) => covers(entry.path, file))) {
			problems.push(`allowlist.json: "${entry.path}" matches no tracked file; remove the entry`);
		}
	}

	return problems;
}

export const FIX = `New services, APIs and web surfaces in PetalNet are built on packages/effect-sveltekit and packages/effect-api (Effect services and layers, typed errors, SvelteKit remote functions).
Fix: build it on those two packages. Read both, plus apps/grove, which uses them, and follow it.
If it truly cannot be, add an entry with a one-line reason to tools/effect-default/allowlist.json in this PR.`;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 })
		.split("\0")
		.filter(Boolean);
	const allowlist = JSON.parse(
		readFileSync(fileURLToPath(new URL("allowlist.json", import.meta.url)), "utf8"),
	) as Exception[];
	const problems = violations(files, allowlist, (file) => readFileSync(file, "utf8"));

	if (problems.length > 0) {
		process.stderr.write(`${problems.join("\n")}\n\n${FIX}\n`);
		process.exit(1);
	}
}
