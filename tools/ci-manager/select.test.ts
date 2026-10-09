import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";
import { assert, test } from "vitest";

const { join } = path;
const turbo = new URL("../../node_modules/turbo/bin/turbo", import.meta.url).pathname;
const cli = new URL("main.ts", import.meta.url).pathname;

test("affected namespace execution includes dependents, excludes unrelated packages and native tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "ci-turbo-"));
	try {
		const run = (command: string, args: string[], env = {}) => {
			const result = spawnSync(command, args, {
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", ...env },
			});
			assert.equal(result.status, 0, result.stderr);
			return result.stdout;
		};
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ private: true, packageManager: "pnpm@12.9.1" }),
		);
		writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
		writeFileSync(
			join(root, "turbo.json"),
			JSON.stringify({ tasks: { check: {}, build: {}, test: {} } }),
		);
		for (const name of ["source", "consumer", "unrelated", "native"]) {
			mkdirSync(join(root, "packages", name), { recursive: true });
			writeFileSync(
				join(root, "packages", name, "package.json"),
				JSON.stringify({
					name: name === "native" ? "native" : `@petalnet/${name}`,
					version: "0.0.0",
					scripts: { check: "echo check", build: "echo build", test: "echo test" },
					dependencies: name === "consumer" ? { "@petalnet/source": "workspace:*" } : {},
				}),
			);
		}
		run("git", ["init", "-q"]);
		run("git", ["add", "."]);
		run("git", [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"fixture",
		]);
		const env = {
			TURBO_SCM_BASE: run("git", ["rev-parse", "HEAD"]).trim(),
			TURBO_SCM_HEAD: "HEAD",
		};
		const plan = () =>
			Schema.decodeSync(
				Schema.fromJsonString(
					Schema.Struct({
						tasks: Schema.Array(Schema.Struct({ taskId: Schema.String, command: Schema.String })),
					}),
				),
			)(
				run(
					process.execPath,
					[
						turbo,
						"run",
						"check",
						"build",
						"test",
						"--affected",
						"--filter=@petalnet/*",
						"--dry=json",
					],
					env,
				),
			);
		assert.deepEqual(plan().tasks, []);
		writeFileSync(join(root, "packages/source/source.ts"), "export const value = 1;\n");
		writeFileSync(join(root, "packages/native/source.rs"), "// native change\n");
		run("git", ["add", "."]);
		run("git", [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"source change",
		]);
		assert.deepEqual(
			plan()
				.tasks.filter((task) => task.command !== "<NONEXISTENT>")
				.map((task) => task.taskId)
				.toSorted(),
			[
				"@petalnet/consumer#build",
				"@petalnet/consumer#check",
				"@petalnet/consumer#test",
				"@petalnet/source#build",
				"@petalnet/source#check",
				"@petalnet/source#test",
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([false, true])(
	"selector only queries ownership and fails on Turbo errors=%s",
	(error) => {
		const root = mkdtempSync(join(tmpdir(), "ci-select-"));
		try {
			mkdirSync(join(root, "bin"));
			for (const command of ["git", "pnpm"]) {
				const output =
					command === "pnpm"
						? JSON.stringify({
								data: {
									affectedPackages: { items: [{ name: "@petalnet/grove", path: "apps/grove" }] },
								},
								...(error ? { errors: [{ message: "planning failed" }] } : {}),
							})
						: "apps/grove/src/routes/+page.svelte\0";
				writeFileSync(
					join(root, "bin", command),
					`#!${process.execPath}\nrequire("node:fs").appendFileSync("commands", JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + "\\n");\nprocess.stdout.write(${JSON.stringify(output)});\n`,
					{ mode: 0o755 },
				);
			}
			writeFileSync(
				join(root, "event.json"),
				JSON.stringify({ pull_request: { base: { sha: "base-sha" } } }),
			);
			const result = spawnSync(process.execPath, [cli, "select"], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${root}/bin:${process.env["PATH"] ?? ""}`,
					GITHUB_EVENT_PATH: join(root, "event.json"),
					GITHUB_OUTPUT: join(root, "outputs"),
				},
			});
			assert.equal(result.status === 0, !error, result.stderr);
			const commands = readFileSync(join(root, "commands"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			assert.deepEqual(
				commands.filter(([command]) => command === "pnpm"),
				[
					[
						"pnpm",
						"exec",
						"turbo",
						"query",
						"affected",
						"--packages",
						"--base",
						"base-sha",
						"--head",
						"HEAD",
					],
				],
			);
			if (!error) {
				assert.match(readFileSync(join(root, "outputs"), "utf8"), /js=true\n/u);
				assert.match(readFileSync(join(root, "outputs"), "utf8"), /base=base-sha\n/u);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
