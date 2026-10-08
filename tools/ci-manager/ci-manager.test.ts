import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { assert, expect, test } from "vitest";

import { evaluateGate } from "./gate.ts";
import { codeqlSelection, nativeSelection } from "./policy.ts";
import { commandOutput } from "./process.ts";

const disabled = {
	"manager-rust": "false",
	"courier-rust": "false",
	"dispatcher-rust": "false",
	"control-plane-rust": "false",
	"box-agent-rust": "false",
	point: "false",
	rust: "false",
	js: "false",
	actions: "false",
	"codeql-js": "false",
	"codeql-python": "false",
};

const required = {
	select: { result: "success", outputs: disabled },
	check: { result: "success" },
	typos: { result: "success" },
	"link-check": { result: "success" },
	zizmor: { result: "success" },
};

const scenarios = [
	{
		name: "JS-only with advanced scans",
		selection: { ...disabled, js: "true", "codeql-js": "true" },
		results: {
			build: "success",
			test: "success",
			"manager-rust": "skipped",
			"courier-rust": "skipped",
			"dispatcher-rust": "skipped",
			"control-plane-rust": "skipped",
			"box-agent-rust": "skipped",
			point: "skipped",
			"codeql-js": "success",
			"codeql-python": "skipped",
			"codeql-actions": "skipped",
			"codeql-rust": "skipped",
		},
	},
	{
		name: "Flutter-only skips unrelated scans",
		selection: { ...disabled, point: "true" },
		results: {
			build: "skipped",
			test: "skipped",
			"manager-rust": "skipped",
			"courier-rust": "skipped",
			"dispatcher-rust": "skipped",
			"control-plane-rust": "skipped",
			"box-agent-rust": "skipped",
			point: "success",
			"codeql-js": "skipped",
			"codeql-python": "skipped",
			"codeql-actions": "skipped",
			"codeql-rust": "skipped",
		},
	},
	{
		name: "full main run",
		selection: {
			"manager-rust": "true",
			"courier-rust": "true",
			"dispatcher-rust": "true",
			"control-plane-rust": "true",
			"box-agent-rust": "true",
			point: "true",
			rust: "true",
			js: "true",
			actions: "true",
			"codeql-js": "true",
			"codeql-python": "true",
		},
		results: {
			build: "success",
			test: "success",
			"manager-rust": "success",
			"courier-rust": "success",
			"dispatcher-rust": "success",
			"control-plane-rust": "success",
			"box-agent-rust": "success",
			point: "success",
			"codeql-js": "success",
			"codeql-python": "success",
			"codeql-actions": "success",
			"codeql-rust": "success",
		},
	},
	{
		name: "Actions scan selected independently of JS and Rust",
		selection: { ...disabled, actions: "true" },
		results: {
			build: "skipped",
			test: "skipped",
			"manager-rust": "skipped",
			"courier-rust": "skipped",
			"dispatcher-rust": "skipped",
			"control-plane-rust": "skipped",
			"box-agent-rust": "skipped",
			point: "skipped",
			"codeql-js": "skipped",
			"codeql-python": "skipped",
			"codeql-actions": "success",
			"codeql-rust": "skipped",
		},
	},
	{
		name: "Python-only scan without JS build/test",
		selection: { ...disabled, "codeql-python": "true" },
		results: {
			build: "skipped",
			test: "skipped",
			"manager-rust": "skipped",
			"courier-rust": "skipped",
			"dispatcher-rust": "skipped",
			"control-plane-rust": "skipped",
			"box-agent-rust": "skipped",
			point: "skipped",
			"codeql-js": "skipped",
			"codeql-python": "success",
			"codeql-actions": "skipped",
			"codeql-rust": "skipped",
		},
	},
	{
		name: "Standalone JS scan without JS build/test",
		selection: { ...disabled, "codeql-js": "true" },
		results: {
			build: "skipped",
			test: "skipped",
			"manager-rust": "skipped",
			"courier-rust": "skipped",
			"dispatcher-rust": "skipped",
			"control-plane-rust": "skipped",
			"box-agent-rust": "skipped",
			point: "skipped",
			"codeql-js": "success",
			"codeql-python": "skipped",
			"codeql-actions": "skipped",
			"codeql-rust": "skipped",
		},
	},
];

for (const scenario of scenarios) {
	const jobs: Record<string, { result: string; outputs?: Record<string, string> }> = {
		...required,
		select: { result: "success", outputs: scenario.selection },
		...Object.fromEntries(
			Object.entries(scenario.results).map(([job, result]) => [job, { result }]),
		),
	};
	test(`${scenario.name}: exact expected conclusions pass`, async () => {
		const conclusions = await Effect.runPromise(evaluateGate(JSON.stringify(jobs)));
		assert.equal(conclusions.length, 17);
	});
	for (const [job, expected] of Object.entries(jobs)) {
		for (const result of ["success", "failure", "cancelled", "skipped"]) {
			if (result === expected.result) continue;
			test(`${scenario.name}: rejects ${job}=${result}`, async () => {
				await expect(
					Effect.runPromise(
						evaluateGate(
							JSON.stringify({
								...jobs,
								[job]: { ...expected, result },
							}),
						),
					),
				).rejects.toThrow(/expected .*got/u);
			});
		}
		test(`${scenario.name}: rejects missing ${job}`, async () => {
			const missing = Object.fromEntries(Object.entries(jobs).filter(([name]) => name !== job));
			await expect(Effect.runPromise(evaluateGate(JSON.stringify(missing)))).rejects.toThrow();
		});
	}
	for (const key of Object.keys(scenario.selection)) {
		test(`${scenario.name}: rejects malformed ${key} selection`, async () => {
			await expect(
				Effect.runPromise(
					evaluateGate(
						JSON.stringify({
							...jobs,
							select: { result: "success", outputs: { ...scenario.selection, [key]: "yes" } },
						}),
					),
				),
			).rejects.toThrow();
		});
	}
	for (const name of ["new-job", "constructor"]) {
		test(`${scenario.name}: rejects unclassified ${name}`, async () => {
			await expect(
				Effect.runPromise(
					evaluateGate(
						JSON.stringify({
							...jobs,
							[name]: { result: "success" },
						}),
					),
				),
			).rejects.toThrow(/Unclassified job/u);
		});
	}
}

test.each(["{", "null", JSON.stringify({ select: { result: "unknown" } })])(
	"malformed gate input %s fails decoding",
	async (json) => {
		await expect(Effect.runPromise(evaluateGate(json))).rejects.toThrow();
	},
);

test("native selection does not confuse JS paths, Rust consumers, or Flutter", () => {
	assert.deepEqual(nativeSelection(["apps/grove/src/routes/+page.svelte", "pnpm-lock.yaml"]), {
		"manager-rust": false,
		"courier-rust": false,
		"dispatcher-rust": false,
		"control-plane-rust": false,
		"box-agent-rust": false,
		point: false,
	} as const);
	assert.deepEqual(nativeSelection(["apps/point/app/lib/main.dart"]), {
		"manager-rust": false,
		"courier-rust": false,
		"dispatcher-rust": false,
		"control-plane-rust": false,
		"box-agent-rust": false,
		point: true,
	} as const);
	for (const path of [
		"Cargo.lock",
		".cargo/config.toml",
		"tools/ci-manager/main.ts",
		".github/actions/setup/action.yml",
	]) {
		assert.deepEqual(nativeSelection([path]), {
			"manager-rust": true,
			"courier-rust": true,
			"dispatcher-rust": true,
			"control-plane-rust": true,
			"box-agent-rust": true,
			point: true,
		} as const);
	}
	assert.deepEqual(
		nativeSelection(
			["apps/dispatcher/src/lib.rs"],
			["", "apps/dispatcher", "apps/box-agent", "apps/control-plane"],
		),
		{
			"manager-rust": false,
			"courier-rust": false,
			"dispatcher-rust": true,
			"control-plane-rust": true,
			"box-agent-rust": true,
			point: false,
		},
	);
});

test("CodeQL selects language inputs independently of Turbo and native jobs", () => {
	const none = { "codeql-js": false, "codeql-python": false, actions: false, rust: false } as const;
	for (const path of ["README.md", "apps/point/app/lib/main.dart"])
		assert.deepEqual(codeqlSelection([path]), none);
	for (const path of [
		"apps/manager/src/main.rs",
		"apps/point/app/rust/src/lib.rs",
		"Cargo.lock",
		"apps/dispatcher/Cargo.toml",
	])
		assert.deepEqual(codeqlSelection([path]), { ...none, rust: true });
	for (const path of [
		"tools/standalone.mjs",
		"packages/types/index.d.ts",
		"apps/grove/src/routes/+page.svelte",
		"apps/point/app/web/index.html",
		"apps/grove/package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"packages/tsconfig/base.json",
		"tsconfig.eslint.json",
		"turbo.json",
		".npmrc",
	]) {
		assert.deepEqual(codeqlSelection([path]), { ...none, "codeql-js": true } as const, path);
	}
	for (const path of [
		"apps/manager/docs/contracts/validate.py",
		"types.pyi",
		"pyproject.toml",
		"requirements-dev.txt",
		"requirements.txt",
		"constraints.txt",
		"Pipfile.lock",
		"poetry.lock",
		"uv.lock",
		"setup.cfg",
		"tox.ini",
		".python-version",
		"apps/manager/docs/contracts/schemas/task-card.schema.json",
	]) {
		assert.deepEqual(codeqlSelection([path]), { ...none, "codeql-python": true } as const, path);
	}
	for (const path of [
		".github/workflows/ci.yml",
		".github/workflows/codeql.yml",
		".github/workflows/codeql-full.yml",
		".github/codeql/config.yml",
		".github/actions/setup/action.yml",
		"tools/ci-manager/policy.ts",
		"mise.lock",
	]) {
		assert.deepEqual(
			codeqlSelection([path]),
			{
				"codeql-js": true,
				"codeql-python": true,
				actions: true,
				rust: true,
			} as const,
			path,
		);
	}
	assert.deepEqual(codeqlSelection([".github/workflows/point-release.yml"]), {
		...none,
		actions: true,
	} as const);
	assert.deepEqual(codeqlSelection([".github/README.md"]), none);
});

test("command output cannot hide a nonzero exit behind valid JSON", async () => {
	const printJson = "process.stdout.write(JSON.stringify({ tasks: [] }))";
	assert.equal(
		await Effect.runPromise(
			commandOutput(process.execPath, ["-e", printJson]).pipe(Effect.provide(NodeServices.layer)),
		),
		'{"tasks":[]}',
	);
	await expect(
		Effect.runPromise(
			commandOutput(process.execPath, ["-e", `${printJson}; process.exit(7)`]).pipe(
				Effect.flip,
				Effect.provide(NodeServices.layer),
			),
		),
	).resolves.toMatchObject({ _tag: "CommandFailed", command: process.execPath, exitCode: 7 });
});

test("real Git/Turbo selection: dependency propagation, rename sides, full runs, invalid base", () => {
	const root = mkdtempSync(join(tmpdir(), "ci-manager-test-"));
	const cli = new URL("./main.ts", import.meta.url).pathname;
	const run = (command: string, args: string[], env?: Record<string, string>) => {
		const result = spawnSync(command, args, {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false", ...env },
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const write = (path: string, data: string) => {
		writeFileSync(join(root, path), data);
	};
	try {
		mkdirSync(join(root, "apps"));
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, "bin/rustup"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		mkdirSync(join(root, ".github/workflows"), { recursive: true });
		mkdirSync(join(root, ".github/actions/fixture"), { recursive: true });
		write(".github/workflows/fixture.yml", "name: fixture\n");
		write(".github/actions/fixture/action.yaml", "name: fixture\n");
		write(".github/README.md", "Documentation\n");
		for (const app of ["consumer", "unrelated", "shared", "point", "source-only"])
			mkdirSync(join(root, "apps", app));
		write("apps/source-only/package.json", JSON.stringify({ name: "@petalnet/source-only" }));
		write("apps/source-only/source.ts", "export const value = 1;\n");
		write("apps/source-only/validate.py", "print(1)\n");
		write(
			"package.json",
			JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@12.9.1" }),
		);
		write("pnpm-workspace.yaml", "packages:\n  - apps/*\npmOnFail: ignore\n");
		write(
			"turbo.json",
			JSON.stringify({
				agentGuidance: false,
				tasks: { build: { dependsOn: ["^build"] }, test: {} },
			}),
		);
		for (const app of ["consumer", "unrelated", "shared"]) {
			write(
				`apps/${app}/package.json`,
				JSON.stringify({
					name: `@petalnet/${app}`,
					scripts: { build: "echo build", test: "echo test" },
					...(app === "consumer" ? { dependencies: { "@petalnet/shared": "workspace:*" } } : {}),
				}),
			);
			write(`apps/${app}/source.txt`, app);
		}
		write(
			"pnpm-lock.yaml",
			"lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/shared: {}\n  apps/unrelated: {}\n  apps/consumer:\n    dependencies:\n      '@petalnet/shared':\n        specifier: workspace:*\n        version: link:../shared\n",
		);
		symlinkSync(
			new URL("../../../node_modules", import.meta.url).pathname,
			join(root, "node_modules"),
		);
		write(".gitignore", "node_modules\n.turbo\nbin\nevent.json\noutput\n");
		run("git", ["init", "-q"]);
		run("git", ["config", "user.email", "fixture@example.com"]);
		run("git", ["config", "user.name", "Fixture"]);
		run("git", ["add", "."]);
		run("git", ["commit", "-qm", "base"]);
		const base = run("git", ["rev-parse", "HEAD"]);
		const select = (event: unknown, eventName = "pull_request") => {
			write("event.json", JSON.stringify(event));
			write("output", "");
			const result = spawnSync(process.execPath, [cli, "select"], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${root}/bin:${process.env["PATH"] ?? ""}`,
					PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
					GITHUB_EVENT_PATH: join(root, "event.json"),
					GITHUB_OUTPUT: join(root, "output"),
					GITHUB_EVENT_NAME: eventName,
					GITHUB_REPOSITORY: "invalid/no-network",
					GITHUB_SHA: "missing",
				},
			});
			return { result, outputs: readFileSync(join(root, "output"), "utf8") };
		};
		write("apps/shared/source.txt", "dependency changed");
		run("git", ["add", "."]);
		run("git", ["commit", "-qm", "shared dependency"]);
		const affected = select({ pull_request: { base: { sha: base } } });
		assert.equal(affected.result.status, 0, affected.result.stderr);
		assert.match(affected.outputs, /js=true/u);
		assert.match(affected.outputs, /rust=false/u);
		assert.match(affected.outputs, /actions=false/u);
		const packageJson =
			affected.outputs
				.split("\n")
				.find((line) => line.startsWith("js-packages="))
				?.slice("js-packages=".length) ?? "";
		const packages = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
			packageJson,
		);
		assert.deepEqual(packages.toSorted(), ["@petalnet/consumer", "@petalnet/shared"]);
		for (const task of ["build", "test"]) {
			const output = run(process.execPath, [cli, task], { JS_PACKAGES_JSON: packageJson });
			assert.match(output, /@petalnet\/consumer/u);
			assert.notMatch(output, /@petalnet\/unrelated/u);
		}
		const plan = run("pnpm", [
			"exec",
			"turbo",
			"run",
			"build",
			"test",
			"--filter=@petalnet/consumer",
			"--filter=@petalnet/shared",
			"--dry=json",
		]);
		assert.match(plan, /@petalnet\/consumer/u);
		assert.notMatch(
			plan,
			/@petalnet\/unrelated/u,
			`${run("git", ["diff"])}\n${affected.result.stderr}`,
		);
		run("git", ["reset", "--hard", base]);
		run("git", ["mv", "apps/shared/source.txt", "apps/point/renamed.dart"]);
		run("git", ["commit", "-qm", "rename across languages"]);
		const renamed = select({ merge_group: { base_sha: base } }, "merge_group");
		assert.equal(renamed.result.status, 0, renamed.result.stderr);
		assert.match(renamed.outputs, /point=true/u);
		assert.match(renamed.outputs, /js=true/u);
		assert.match(renamed.outputs, /actions=false/u);
		for (const [path, expected] of [
			[".github/workflows/fixture.yml", "true"],
			[".github/actions/fixture/action.yaml", "true"],
			[".github/README.md", "false"],
		] as const) {
			run("git", ["reset", "--hard", base]);
			write(path, "changed\n");
			run("git", ["add", "."]);
			run("git", ["commit", "-qm", path]);
			const changed = select({ pull_request: { base: { sha: base } } });
			assert.equal(changed.result.status, 0, changed.result.stderr);
			assert.match(changed.outputs, new RegExp(`actions=${expected}`, "u"));
		}
		run("git", ["reset", "--hard", base]);
		run("git", ["mv", ".github/workflows/fixture.yml", "former-workflow.txt"]);
		run("git", ["commit", "-qm", "workflow renamed outside Actions paths"]);
		const deletedWorkflow = select({ merge_group: { base_sha: base } }, "merge_group");
		assert.equal(deletedWorkflow.result.status, 0, deletedWorkflow.result.stderr);
		assert.match(deletedWorkflow.outputs, /actions=true/u);
		for (const [path, jsScan, pythonScan] of [
			["apps/source-only/source.ts", "true", "false"],
			["apps/source-only/validate.py", "false", "true"],
		] as const) {
			run("git", ["reset", "--hard", base]);
			write(path, "changed\n");
			run("git", ["add", "."]);
			run("git", ["commit", "-qm", path]);
			const changed = select({ pull_request: { base: { sha: base } } });
			assert.equal(changed.result.status, 0, changed.result.stderr);
			assert.match(changed.outputs, /^js=false$/mu);
			assert.match(changed.outputs, new RegExp(`^codeql-js=${jsScan}$`, "mu"));
			assert.match(changed.outputs, new RegExp(`^codeql-python=${pythonScan}$`, "mu"));
		}
		run("git", ["reset", "--hard", base]);
		run("git", ["mv", "apps/source-only/source.ts", "apps/source-only/source.txt"]);
		run("git", ["mv", "apps/source-only/validate.py", "apps/source-only/validate.txt"]);
		run("git", ["commit", "-qm", "source renamed outside scanned extensions"]);
		const deletedSources = select({ merge_group: { base_sha: base } }, "merge_group");
		assert.equal(deletedSources.result.status, 0, deletedSources.result.stderr);
		assert.match(deletedSources.outputs, /^codeql-js=true$/mu);
		assert.match(deletedSources.outputs, /^codeql-python=true$/mu);
		for (const eventName of ["workflow_dispatch", "push"]) {
			const full = select({}, eventName);
			assert.equal(full.result.status, 0, full.result.stderr);
			assert.match(full.outputs, /affected=false/u);
			assert.match(full.outputs, /manager-rust=true/u);
			assert.match(full.outputs, /js=true/u);
			assert.match(full.outputs, /actions=true/u);
			assert.match(full.outputs, /rust=true/u);
			assert.match(full.outputs, /^codeql-js=true$/mu);
			assert.match(full.outputs, /^codeql-python=true$/mu);
		}
		const bad = select({ merge_group: { base_sha: "nonexistent-ref" } }, "merge_group");
		assert.notEqual(bad.result.status, 0);
		assert.equal(bad.outputs, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
