// New JS/TS web apps and API servers in this repo are built on packages/effect-sveltekit and packages/effect-api.
// This check scans the tracked apps/*/package.json files and fails on one that depends on a JS server or web
// framework but not on them, unless allowlist.json lists it. Other languages and kinds of project (Python
// inference and data work, Rust, Flutter, hooks, CLIs) are out of scope and never flagged.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Exception {
	readonly path: string;
	readonly reason: string;
}

const BUILT_ON = ["@petalnet/effect-sveltekit", "@petalnet/effect-api"];
// A package that depends on one of these serves HTTP or renders a web app.
const SERVER_FRAMEWORKS = [
	"@sveltejs/kit",
	"express",
	"hono",
	"fastify",
	"koa",
	"next",
	"nuxt",
	"elysia",
	"@nestjs/core",
	"@hapi/hapi",
	"@remix-run/node",
];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

const covers = (entry: string, file: string) => file === entry || file.startsWith(`${entry}/`);

const dependsOn = (manifest: string, names: readonly string[]) => {
	const parsed = JSON.parse(manifest) as Record<string, Record<string, string> | undefined>;

	return DEP_FIELDS.some((field) => names.some((name) => parsed[field]?.[name] !== undefined));
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

		if (!/^apps\/[^/]+\/package\.json$/u.test(file)) {
			continue;
		}

		const manifest = read(file);

		if (dependsOn(manifest, SERVER_FRAMEWORKS) && !dependsOn(manifest, BUILT_ON)) {
			problems.push(
				`${file}: JS web app or server without @petalnet/effect-sveltekit or @petalnet/effect-api`,
			);
		}
	}

	for (const entry of allowlist) {
		if (!files.some((file) => covers(entry.path, file))) {
			problems.push(`allowlist.json: "${entry.path}" matches no tracked file; remove the entry`);
		}
	}

	return problems;
}

export const FIX = `New JS/TS web apps and API servers in PetalNet are built on packages/effect-sveltekit and packages/effect-api (Effect services and layers, typed errors, SvelteKit remote functions).
Fix: build it on those two packages. Read both, plus apps/grove, which uses them, and follow it.
If it truly cannot be, add an entry with a one-line reason to tools/effect-default/allowlist.json in this PR.
Python inference or data work, Rust, Flutter, hooks and CLIs are not covered by this check.`;

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
