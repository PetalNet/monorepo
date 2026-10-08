import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const policy = new URL("../src/policy.ts", import.meta.url);
const original = readFileSync(policy, "utf8");
const mutations = [
	["repository gate", "claims.repository !== repository", "false"],
	["push event gate", 'claims.event_name === "push"', "true"],
	["main ref gate", 'claims.ref === "refs/heads/main"', "true"],
	["merge event gate", 'claims.event_name === "merge_group"', "true"],
	["Dependabot gate", 'claims.actor === "dependabot[bot]"', "false"],
	["PR head proof", "&& sameRepoPull", ""],
];

try {
	for (const [name, before, after] of mutations) {
		if (
			name === undefined ||
			before === undefined ||
			after === undefined ||
			!original.includes(before)
		) {
			throw new Error("Mutation target missing");
		}

		writeFileSync(policy, original.replace(before, after));

		const result = spawnSync("pnpm", ["exec", "vitest", "run", "test/policy.test.ts"], {
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
		});

		if (result.status !== 1 || !(result.stdout + result.stderr).includes("AssertionError")) {
			throw new Error(
				`Mutation ${name} survived or failed to run: ${result.stdout}${result.stderr}`,
			);
		}

		process.stdout.write(`KILLED ${name}\n`);
	}
} finally {
	writeFileSync(policy, original);
}
