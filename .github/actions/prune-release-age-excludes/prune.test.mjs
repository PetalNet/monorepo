import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const now = Date.parse("2026-10-09T12:00:00.000Z");

async function run(t, source, packages = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), "prune-release-age-"));

	t.after(() => rm(directory, { recursive: true, force: true }));

	const server = createServer((request, response) => {
		const name = decodeURIComponent(request.url.slice("/registry/".length));
		const metadata = packages[name];

		response.writeHead(metadata === undefined ? 404 : 200, { "Content-Type": "application/json" });
		response.end(JSON.stringify(metadata ?? {}));
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const file = path.join(directory, "pnpm-workspace.yaml");
	const output = path.join(directory, "output");

	await writeFile(file, source);

	const script = new URL("./prune.mjs", import.meta.url).href;
	const command = execute(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`Date.now = () => ${now}; await import(${JSON.stringify(script)});`,
		],
		{
			env: {
				...process.env,
				WORKSPACE_FILE: file,
				REGISTRY: `http://127.0.0.1:${server.address().port}/registry/`,
				GITHUB_OUTPUT: output,
			},
		},
	);

	return {
		command,
		file: () => readFile(file, "utf8"),
		output: () => readFile(output, "utf8"),
	};
}

test("removes only exact versions at or beyond the configured age, retaining comments", async (t) => {
	const source = `# Workspace policy
minimumReleaseAge: 120
minimumReleaseAgeExclude:
  - old@1.2.3 # temporary bypass
  - '@scope/pkg@2.0.0-beta.1+build.7'
  - boundary@3.0.0
  - young@4.0.0 # still needed
  - missing@1.0.0
  - invalid@1.0.0
  - unavailable@1.0.0

catalog:
  old: '1.2.3' # unrelated
`;
	const result = await run(t, source, {
		old: { time: { "1.2.3": "2026-10-08T12:00:00.000Z" } },
		"@scope/pkg": { time: { "2.0.0-beta.1+build.7": "2026-10-09T09:00:00.000Z" } },
		boundary: { time: { "3.0.0": "2026-10-09T10:00:00.000Z" } },
		young: { time: { "4.0.0": "2026-10-09T10:00:00.001Z" } },
		missing: { time: {} },
		invalid: { time: { "1.0.0": "not a timestamp" } },
	});

	await result.command;

	assert.equal(
		await result.file(),
		source
			.replace("  - old@1.2.3 # temporary bypass\n", "")
			.replace("  - '@scope/pkg@2.0.0-beta.1+build.7'\n", "")
			.replace("  - boundary@3.0.0\n", ""),
	);

	assert.equal(
		await result.output(),
		'changed=true\nremoved=["old@1.2.3","@scope/pkg@2.0.0-beta.1+build.7","boundary@3.0.0"]\n',
	);
});

test("uses pnpm's one-day default and leaves a no-op file byte-identical", async (t) => {
	const source = "minimumReleaseAgeExclude: [recent@1.0.0]\n";
	const result = await run(t, source, {
		recent: { time: { "1.0.0": "2026-10-08T12:00:00.001Z" } },
	});

	await result.command;
	assert.equal(await result.file(), source);
	assert.equal(await result.output(), "changed=false\nremoved=[]\n");

	const aged = await run(t, source, {
		recent: { time: { "1.0.0": "2026-10-08T12:00:00.000Z" } },
	});

	await aged.command;
	assert.equal(await aged.file(), "minimumReleaseAgeExclude: []\n");
	assert.equal(await aged.output(), 'changed=true\nremoved=["recent@1.0.0"]\n');
});

test("handles an absent list and refuses invalid configuration without editing", async (t) => {
	for (const source of [
		"packages: [apps/*]\n",
		"minimumReleaseAge: -1\nminimumReleaseAgeExclude: [old@1.0.0]\n",
		"minimumReleaseAgeExclude: old@1.0.0\n",
		"minimumReleaseAgeExclude: [\n",
	]) {
		const result = await run(t, source);

		if (source.startsWith("packages:")) {
			await result.command;
			assert.equal(await result.output(), "changed=false\nremoved=[]\n");
		} else {
			await assert.rejects(result.command);
		}

		assert.equal(await result.file(), source);
	}
});

test("requires exact versions throughout the list without partially pruning", async (t) => {
	for (const entry of [
		"old",
		"@scope/pkg",
		"@scope/*",
		"old@^1.0.0",
		"old@1.2.3 || 2.0.0",
		"old@latest",
		"old@1.0.0-01",
		"old@1.0.0-beta..1",
	]) {
		const source = `minimumReleaseAgeExclude:\n  - '${entry}'\n  - old@1.0.0\n`;
		const result = await run(t, source, {
			old: { time: { "1.0.0": "2026-10-01T00:00:00.000Z" } },
		});

		await assert.rejects(result.command, (error) => {
			assert.match(error.stderr, /must use an exact version/u);
			assert.match(error.stderr, /Replace package-wide entries/u);

			return true;
		});

		assert.equal(await result.file(), source);
		await assert.rejects(result.output(), { code: "ENOENT" });
	}
});
