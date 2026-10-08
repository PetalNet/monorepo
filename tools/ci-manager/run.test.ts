import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { assert, test } from "vitest";

const cli = new URL("./main.ts", import.meta.url).pathname;

function execute(task: string, packages: string, exit = 0) {
	const root = mkdtempSync(join(tmpdir(), "ci-run-"));
	try {
		mkdirSync(join(root, "bin"));
		writeFileSync(
			join(root, "bin/pnpm"),
			`#!${process.execPath}\nrequire("node:fs").writeFileSync("argv", JSON.stringify(process.argv.slice(2)));\nconsole.log("execution diagnostic");\nprocess.exit(${String(exit)});\n`,
			{ mode: 0o755 },
		);
		const result = spawnSync(process.execPath, [cli, task], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${root}/bin:${process.env["PATH"] ?? ""}`,
				JS_PACKAGES_JSON: packages,
			},
		});
		const args = existsSync(join(root, "argv"))
			? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
					readFileSync(join(root, "argv"), "utf8"),
				)
			: [];
		return { result, args };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test.each(["build", "test"])(
	"%s invokes exact filters, never root scripts or affected execution",
	(task) => {
		const { result, args } = execute(task, '["@petalnet/grove","@petalnet/effect-api"]');
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(args, [
			"exec",
			"turbo",
			"run",
			task,
			"--filter=@petalnet/grove",
			"--filter=@petalnet/effect-api",
		]);
	},
);

test.each([
	"[]",
	"null",
	"{",
	'["@petalnet/*"]',
	'["@petalnet/grove..."]',
	'["!@petalnet/grove"]',
	'["@petalnet/grove;echo unsafe"]',
	'["@petalnet/grove\\n--filter=*"]',
	'["@petalnet/grove\\n"]',
	'["@petalnet/grove\\r"]',
])("invalid/empty package input %s never invokes Turbo", (packages) => {
	const { result, args } = execute("build", packages);
	assert.notEqual(result.status, 0);
	assert.deepEqual(args, []);
});

test("failed execution is not converted to success", () => {
	const { result, args } = execute("test", '["@petalnet/whoami"]', 7);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /execution diagnostic/u);
	assert.deepEqual(args, ["exec", "turbo", "run", "test", "--filter=@petalnet/whoami"]);
});
