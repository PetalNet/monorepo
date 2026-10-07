import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { evaluateGate } from "./gate.ts";
import { nativeSelection, queueAlreadyCheckedFormatting } from "./policy.ts";
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
	format: "true",
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
		codeql: "true",
		selection: { ...disabled, js: "true" },
		results: {
			build: "success",
			test: "success",
			"manager-rust": "skipped",
			"courier-rust": "skipped",
			"dispatcher-rust": "skipped",
			"control-plane-rust": "skipped",
			"box-agent-rust": "skipped",
			point: "skipped",
			"codeql-other": "success",
			"codeql-rust": "skipped",
		},
	},
	{
		name: "Flutter-only before advanced activation",
		codeql: "false",
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
			"codeql-other": "skipped",
			"codeql-rust": "skipped",
		},
	},
	{
		name: "full main run after queue formatting",
		codeql: "true",
		selection: {
			"manager-rust": "true",
			"courier-rust": "true",
			"dispatcher-rust": "true",
			"control-plane-rust": "true",
			"box-agent-rust": "true",
			point: "true",
			rust: "true",
			js: "true",
			format: "false",
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
			"codeql-other": "success",
			"codeql-rust": "success",
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
	await test(`${scenario.name}: exact expected conclusions pass`, async () => {
		const conclusions = await Effect.runPromise(evaluateGate(jobs, scenario.codeql));
		assert.equal(conclusions.length, 15);
	});
	for (const [job, expected] of Object.entries(jobs)) {
		for (const result of ["success", "failure", "cancelled", "skipped"]) {
			if (result === expected.result) continue;
			await test(`${scenario.name}: rejects ${job}=${result}`, async () => {
				await assert.rejects(
					Effect.runPromise(
						evaluateGate(
							{
								...jobs,
								[job]: { ...expected, result },
							},
							scenario.codeql,
						),
					),
					/expected .*got/u,
				);
			});
		}
		await test(`${scenario.name}: rejects missing ${job}`, async () => {
			const missing = Object.fromEntries(Object.entries(jobs).filter(([name]) => name !== job));
			await assert.rejects(Effect.runPromise(evaluateGate(missing, scenario.codeql)));
		});
	}
	for (const key of Object.keys(scenario.selection)) {
		await test(`${scenario.name}: rejects malformed ${key} selection`, async () => {
			await assert.rejects(
				Effect.runPromise(
					evaluateGate(
						{
							...jobs,
							select: { result: "success", outputs: { ...scenario.selection, [key]: "yes" } },
						},
						scenario.codeql,
					),
				),
			);
		});
	}
	for (const name of ["new-job", "constructor"]) {
		await test(`${scenario.name}: rejects unclassified ${name}`, async () => {
			await assert.rejects(
				Effect.runPromise(
					evaluateGate(
						{
							...jobs,
							[name]: { result: "success" },
						},
						scenario.codeql,
					),
				),
				/Unclassified job/u,
			);
		});
	}
}

await test("native selection does not confuse JS paths, Rust consumers, or Flutter", () => {
	assert.deepEqual(nativeSelection(["apps/grove/src/routes/+page.svelte", "pnpm-lock.yaml"]), {
		"manager-rust": false,
		"courier-rust": false,
		"dispatcher-rust": false,
		"control-plane-rust": false,
		"box-agent-rust": false,
		point: false,
		rust: false,
	} as const);
	assert.deepEqual(nativeSelection(["apps/point/app/lib/main.dart"]), {
		"manager-rust": false,
		"courier-rust": false,
		"dispatcher-rust": false,
		"control-plane-rust": false,
		"box-agent-rust": false,
		point: true,
		rust: false,
	} as const);
	for (const path of [
		"apps/dispatcher/src/lib.rs",
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
			rust: true,
		} as const);
	}
});

await test("formatting reuse requires success, merge_group, and the exact head together", () => {
	const matching = { event: "merge_group", head_sha: "head", conclusion: "success" };
	assert.equal(queueAlreadyCheckedFormatting({ workflow_runs: [matching] }, "head"), true);
	for (const run of [
		{ ...matching, head_sha: "base" },
		{ ...matching, event: "pull_request" },
		{ ...matching, conclusion: "failure" },
		{ ...matching, conclusion: null },
	]) {
		assert.equal(queueAlreadyCheckedFormatting({ workflow_runs: [run] }, "head"), false);
	}
	assert.equal(queueAlreadyCheckedFormatting({ workflow_runs: [] }, "head"), false);
});

await test("command output cannot hide a nonzero exit behind valid JSON", async () => {
	const printJson = "process.stdout.write(JSON.stringify({ tasks: [] }))";
	assert.equal(
		await Effect.runPromise(
			commandOutput(process.execPath, ["-e", printJson]).pipe(Effect.provide(NodeServices.layer)),
		),
		'{"tasks":[]}',
	);
	await assert.rejects(
		Effect.runPromise(
			commandOutput(process.execPath, ["-e", `${printJson}; process.exit(7)`]).pipe(
				Effect.provide(NodeServices.layer),
			),
		),
		/CommandFailed/u,
	);
});

await test("real Git/Turbo selection: dependency propagation, rename sides, full runs, invalid base", () => {
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
		for (const app of ["consumer", "unrelated", "shared", "point"])
			mkdirSync(join(root, "apps", app));
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
			new URL("../../node_modules", import.meta.url).pathname,
			join(root, "node_modules"),
		);
		write(".gitignore", "node_modules\n.turbo\nevent.json\noutput\n");
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
		const plan = run(
			"pnpm",
			["exec", "turbo", "run", "build", "test", "--affected", "--dry=json"],
			{ TURBO_SCM_BASE: base, TURBO_SCM_HEAD: "HEAD" },
		);
		assert.match(plan, /@petalnet\/consumer/u);
		assert.doesNotMatch(
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
		assert.match(renamed.outputs, /format=true/u);
		const manual = select({}, "workflow_dispatch");
		assert.equal(manual.result.status, 0, manual.result.stderr);
		assert.match(manual.outputs, /affected=false/u);
		assert.match(manual.outputs, /manager-rust=true/u);
		assert.match(manual.outputs, /js=true/u);
		assert.match(manual.outputs, /format=true/u);
		mkdirSync(join(root, "bin"));
		writeFileSync(
			join(root, "bin/gh"),
			`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ workflow_runs: [{ event: "merge_group", head_sha: "missing", conclusion: "success" }] }));\n`,
			{ mode: 0o755 },
		);
		const originalPath = process.env["PATH"];
		try {
			process.env["PATH"] = `${join(root, "bin")}:${originalPath ?? ""}`;
			const main = select({}, "push");
			assert.equal(main.result.status, 0, main.result.stderr);
			assert.match(main.outputs, /format=false/u);
			assert.match(main.outputs, /js=true/u);
			assert.match(main.outputs, /courier-rust=true/u);
			assert.match(main.outputs, /affected=false/u);
			writeFileSync(join(root, "bin/gh"), `#!${process.execPath}\nprocess.exit(3);\n`, {
				mode: 0o755,
			});
			const fallback = select({}, "push");
			assert.equal(fallback.result.status, 0, fallback.result.stderr);
			assert.match(fallback.outputs, /format=true/u);
		} finally {
			if (originalPath === undefined) delete process.env["PATH"];
			else process.env["PATH"] = originalPath;
		}
		const bad = select({ merge_group: { base_sha: "nonexistent-ref" } }, "merge_group");
		assert.notEqual(bad.result.status, 0);
		assert.equal(bad.outputs, "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
