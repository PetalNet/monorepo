import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";

import { refresh } from "../src/api.ts";
import { Vault } from "../src/engine.ts";
import { remember } from "../src/research.ts";
import { readText, seeded, state, tempDir, test, vaultAt, writeText } from "./tools.ts";

const token = `ghp_${"a1B2".repeat(9)}`;

describe("refresh", () => {
	test("keeps the saved claim when the read side cannot be refreshed", () =>
		Effect.gen(function* () {
			const blocked = path.join(yield* tempDir, "file");

			yield* writeText(blocked, "not a directory");

			const vault = yield* vaultAt();

			yield* Effect.gen(function* () {
				yield* seeded;
				const claim = yield* remember("shared", { text: "Saved once.", topic: "Note granularity" });

				yield* refresh;
				expect(Object.keys((yield* state("shared")).claims)).toEqual([claim.id]);
			}).pipe(Effect.provideService(Vault, { ...vault, projection: path.join(blocked, "vault") }));
		}));
});

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
					VAULT_PROJECTION: path.join(root, "obsidian"),
				},
			},
		);

	test(
		"writes, recalls, projects and refuses through the same operations",
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

				expect(
					yield* readText(root, "obsidian", "shared", "Topics", "Note granularity.md"),
				).toContain("- A hunch about notes. [basis:: GUESS]");

				const refused = cli(root, "remember", "--topic", "Note granularity", `token ${token}`);

				expect(refused.status).toBe(1);
				expect(refused.stderr).toMatch(/Secret scan rejected the write to .*: github-pat/);
				expect(refused.stderr).not.toContain(token);
			}),
		60_000,
	);
});
