import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";

import { tempDir, test } from "./tools.ts";

const token = `ghp_${"a1B2".repeat(9)}`;

describe("CLI", () => {
	const cli = (root: string, ...args: string[]) =>
		spawnSync(
			process.execPath,
			["--no-warnings", path.join(import.meta.dirname, "../src/cli.ts"), ...args],
			{
				encoding: "utf8",
				env: {
					...process.env,
					VAULT_ROOT: root,
					VAULT_AGENT: "cli-test",
				},
			},
		);

	test(
		"writes, recalls and refuses through the same operations",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDir;
				const saved = cli(
					root,
					"remember",
					"--topic",
					"Note granularity",
					"A",
					"hunch",
					"about",
					"notes.",
				);

				expect(saved.status).toBe(0);

				expect(JSON.parse(saved.stdout)).toMatchObject({
					text: "A hunch about notes.",
					agent: "cli-test",
				});

				expect(cli(root, "recall", "hunch").stdout).toMatch(
					/^\[c-[a-z0-9]{8}\] Note granularity > Notes: A hunch about notes\./,
				);

				const refused = cli(root, "remember", "--topic", "Note granularity", `token ${token}`);

				expect(refused.status).toBe(1);
				expect(refused.stderr).toMatch(/Secret scan rejected the write to .*: github-pat/);
				expect(refused.stderr).not.toContain(token);
			}),
		60_000,
	);
});
