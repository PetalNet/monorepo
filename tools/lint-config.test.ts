import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ESLint, type Linter } from "eslint";

import config from "../eslint.config.ts";
import knipConfig from "../knip.config.ts";
import formatConfig from "../oxfmt.config.ts";
import packageJson from "../package.json" with { type: "json" };

await test("Oxlint deduplication leaves every Svelte rule and existing Slide policy intact", async () => {
	const eslint = new ESLint();
	const withoutOxlint = new ESLint({
		overrideConfigFile: true,
		overrideConfig: config.filter((entry) => !entry.name?.startsWith("oxlint/")),
	});
	const files = [
		"apps/grove/src/routes/+layout.svelte",
		"apps/collegemap/src/routes/+page.svelte",
		"apps/storybook/src/stories/Button.svelte",
		"apps/slide/src/routes/+page.svelte",
		"apps/whoami/src/routes/+page.svelte",
	];
	const configurations = await Promise.all(
		files.map(async (file) => ({
			file,
			actual: (await eslint.calculateConfigForFile(file)) as Linter.Config | undefined,
			expected: (await withoutOxlint.calculateConfigForFile(file)) as Linter.Config | undefined,
		})),
	);
	for (const { file, actual, expected } of configurations) {
		assert.ok(actual, `${file} must not be globally ignored`);
		assert.ok(expected);
		// oxlint-disable-next-line typescript/no-unnecessary-condition -- deepEqual checks runtime equality, not just assignable types.
		assert.deepEqual(actual.rules, expected.rules, file);
	}
	const svelte = (await eslint.calculateConfigForFile(
		"apps/grove/src/routes/+layout.svelte",
	)) as Linter.Config;
	assert.deepEqual(svelte.rules?.["@typescript-eslint/no-floating-promises"], [2]);
	assert.deepEqual(svelte.rules["@typescript-eslint/no-unsafe-assignment"], [2]);
	const ts = (await eslint.calculateConfigForFile(
		"apps/grove/src/lib/theme.svelte.ts",
	)) as Linter.Config;
	assert.deepEqual(ts.rules?.["@typescript-eslint/no-floating-promises"], [0]);
	assert.deepEqual(ts.rules["@typescript-eslint/no-unsafe-assignment"], [0]);
});

await test("the installed backend checks typed code and only allows approved unstable APIs", () => {
	const directory = mkdtempSync(join(process.cwd(), "packages/effect-api/lint-config-fixture-"));
	try {
		writeFileSync(
			join(directory, "tsconfig.json"),
			JSON.stringify({
				extends: "../../tsconfig/base.json",
				compilerOptions: { strict: true, noEmit: true, composite: false },
				include: ["*.ts"],
			}),
		);
		const good = join(directory, "good.ts");
		const bad = join(directory, "bad.ts");
		writeFileSync(
			good,
			[
				'import { Effect } from "effect";',
				'import { HttpServerRequest } from "effect/http";',
				"void Promise.resolve(1);",
				"export const effect = Effect.succeed(1);",
				'export const request = HttpServerRequest.fromWeb(new Request("https://example.com"));',
			].join("\n"),
		);
		writeFileSync(
			bad,
			[
				'import { Effect } from "effect";',
				'import { RpcClient } from "effect/rpc";',
				"Promise.resolve(1);",
				"Effect.succeed(1);",
				"export const makeClient = RpcClient.makeNoSerialization;",
			].join("\n"),
		);
		const run = (file: string) =>
			spawnSync(
				"node_modules/.bin/oxlint",
				["--no-ignore", "--max-warnings=0", "--format", "json", file],
				{ encoding: "utf8" },
			);
		const valid = run(good);
		assert.equal(valid.status, 0, valid.stdout + valid.stderr);
		const validReport = JSON.parse(valid.stdout) as { diagnostics: unknown[] };
		assert.deepEqual(validReport.diagnostics, []);
		const invalid = run(bad);
		assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
		const invalidReport = JSON.parse(invalid.stdout) as { diagnostics: { code: string }[] };
		const rules = new Set(invalidReport.diagnostics.map((diagnostic) => diagnostic.code));
		assert.ok(rules.has("typescript(no-floating-promises)"), invalid.stdout);
		assert.ok(rules.has("effecttsgo(floating-effect)"), invalid.stdout);
		assert.ok(rules.has("effecttsgo(unstable-api-usage)"), invalid.stdout);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

await test("Oxfmt owns package sorting while ESLint retains manifest validation", async () => {
	const manifest = (await new ESLint().calculateConfigForFile("package.json")) as Linter.Config;
	const order = manifest.rules?.["package-json/order-properties"];
	const collections = manifest.rules?.["package-json/sort-collections"];
	assert.ok(Array.isArray(order));
	assert.ok(Array.isArray(collections));
	assert.equal(order[0], 0);
	assert.equal(collections[0], 0);
	assert.deepEqual(manifest.rules?.["package-json/valid-name"], [2]);
	assert.equal(formatConfig.sortPackageJson, true);
	assert.ok(!formatConfig.ignorePatterns.includes("**/package.json"));
});

await test("Knip's configured cycle policy rejects runtime cycles", () => {
	const directory = mkdtempSync(join(process.cwd(), "tools/lint-cycle-fixture-"));
	try {
		writeFileSync(join(directory, "package.json"), '{"name":"lint-cycle-fixture","private":true}');
		writeFileSync(
			join(directory, "a.ts"),
			'import { b } from "./b.ts"; export const a = () => b();',
		);
		writeFileSync(
			join(directory, "b.ts"),
			'import { a } from "./a.ts"; export const b = () => a();',
		);
		writeFileSync(
			join(directory, "knip.json"),
			JSON.stringify({
				entry: ["a.ts!"],
				project: ["*.ts!"],
				rules: knipConfig.rules,
			}),
		);
		const run = (command: "lint:knip" | "lint:knip:prod") =>
			spawnSync(
				"node_modules/.bin/knip",
				[
					...packageJson.scripts[command].split(" ").slice(1),
					"--directory",
					directory,
					"--config",
					join(directory, "knip.json"),
					"--no-config-hints",
				],
				{ encoding: "utf8" },
			);
		for (const command of ["lint:knip", "lint:knip:prod"] as const) {
			const cyclic = run(command);
			assert.equal(cyclic.status, 1, cyclic.stdout + cyclic.stderr);
			assert.match(cyclic.stdout, /Circular dependencies/);
		}
		writeFileSync(join(directory, "b.ts"), "export const b = () => 1;");
		for (const command of ["lint:knip", "lint:knip:prod"] as const) {
			const acyclic = run(command);
			assert.equal(acyclic.status, 0, acyclic.stdout + acyclic.stderr);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
