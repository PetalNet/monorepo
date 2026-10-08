import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Schema } from "effect";
import { assert, test } from "vitest";

const lanes = [
	"manager-rust",
	"courier-rust",
	"dispatcher-rust",
	"control-plane-rust",
	"box-agent-rust",
	"point",
];
const cli = new URL("./main.ts", import.meta.url).pathname;
const nativeTests = process.env["CI_MANAGER_NATIVE_TESTS"] === "true";

function fixture() {
	const root = mkdtempSync(new URL("./.native-fixture-", import.meta.url).pathname);
	const write = (path: string, data: string, executable = false) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), data, { mode: executable ? 0o755 : 0o644 });
	};
	const env = {
		...process.env,
		PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
		PATH: `${root}/bin:${process.env["PATH"] ?? ""}`,
	};
	const run = (command: string, args: string[], extraEnv: Record<string, string> = {}) => {
		const result = spawnSync(command, args, {
			cwd: root,
			env: { ...env, ...extraEnv },
			encoding: "utf8",
		});
		if (result.status !== 0) rmSync(root, { recursive: true, force: true });
		assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
		return result.stdout.trim();
	};
	write(
		"package.json",
		JSON.stringify({ name: "native-fixture", private: true, packageManager: "pnpm@12.9.1" }),
	);
	write("pnpm-workspace.yaml", "packages:\n  - apps/web\npmOnFail: ignore\n");
	write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/web: {}\n");
	write(
		"turbo.json",
		JSON.stringify({
			agentGuidance: false,
			futureFlags: { experimentalCargoWorkspaces: true },
			tasks: { build: { dependsOn: ["^build"] }, test: {} },
		}),
	);
	write("rust-toolchain.toml", '[toolchain]\nchannel = "1.96"\n');
	const crates = [
		"manager",
		"courier",
		"dispatcher",
		"control-plane",
		"box-agent",
		"point/core",
		"point/server",
	];
	write(
		"Cargo.toml",
		`[workspace]\nresolver = "2"\nmembers = [${crates.map((app) => `"apps/${app}"`).join(", ")}]\n[workspace.metadata]\nname = "native-workspace"\n`,
	);
	for (const app of crates) {
		const name = app.replace("/", "-");
		const dependency = ["box-agent", "control-plane"].includes(app)
			? '\n[dependencies]\ndispatcher = { path = "../dispatcher" }\n'
			: app === "point/server"
				? '\n[dependencies]\npoint-core = { path = "../core" }\n'
				: "";
		write(
			`apps/${app}/Cargo.toml`,
			`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n${dependency}`,
		);
		write(`apps/${app}/src/lib.rs`, "pub fn fixture() {}\n");
		write(`apps/${app}/notes.txt`, "native documentation\n");
	}
	write(
		"Cargo.lock",
		`version = 4\n${crates.map((app) => `\n[[package]]\nname = "${app.replace("/", "-")}"\nversion = "0.1.0"\n${["box-agent", "control-plane"].includes(app) ? 'dependencies = ["dispatcher"]\n' : app === "point/server" ? 'dependencies = ["point-core"]\n' : ""}`).join("")}`,
	);
	write("apps/dispatcher/src/movable.rs", "pub fn movable() {}\n");
	write("apps/point/app/lib/main.dart", "void main() {}\n");
	write("apps/point/app/lib/src/rust/bridge_generated.dart", "// generated bridge\n");
	write(
		"apps/web/package.json",
		JSON.stringify({ name: "@petalnet/web", scripts: { build: "echo build", test: "echo test" } }),
	);
	write("apps/web/index.ts", "export const value = 1;\n");
	write(".gitignore", "node_modules\n.turbo\nbin\nevent.json\noutput\nrustup.log\ntarget\n");
	symlinkSync("../../../node_modules", join(root, "node_modules"));
	// Queries use real Cargo metadata; only toolchain installation is stubbed.
	write("bin/rustup", '#!/bin/sh\nprintf "%s\\n" "$*" >> rustup.log\nexit 0\n', true);
	run("git", ["init", "-q"]);
	run("git", ["config", "user.email", "native@example.com"]);
	run("git", ["config", "user.name", "Native fixture"]);
	run("git", ["config", "commit.gpgsign", "false"]);
	run("git", ["add", "."]);
	run("git", ["commit", "-qm", "base"]);
	const base = run("git", ["rev-parse", "HEAD"]);
	const commit = () => {
		run("git", ["add", "."]);
		run("git", ["commit", "-qm", "change"]);
	};
	const select = () => {
		write("event.json", JSON.stringify({ pull_request: { base: { sha: base } } }));
		write("output", "");
		const result = spawnSync(process.execPath, [cli, "select"], {
			cwd: root,
			encoding: "utf8",
			env: {
				...env,
				GITHUB_EVENT_PATH: join(root, "event.json"),
				GITHUB_OUTPUT: join(root, "output"),
				GITHUB_EVENT_NAME: "pull_request",
			},
		});
		const output = readFileSync(join(root, "output"), "utf8");
		return {
			result,
			output,
			flags: Object.fromEntries(
				output
					.trim()
					.split("\n")
					.map((line) => {
						const equals = line.indexOf("=");
						return [line.slice(0, equals), line.slice(equals + 1)] as const;
					}),
			),
		};
	};
	const queryPaths = () => {
		const query = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					data: Schema.Struct({
						affectedPackages: Schema.Struct({
							items: Schema.Array(Schema.Struct({ path: Schema.String })),
						}),
					}),
					errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
				}),
			),
		)(
			run("pnpm", [
				"exec",
				"turbo",
				"query",
				"affected",
				"--packages",
				"--base",
				base,
				"--head",
				"HEAD",
			]),
		);
		assert.ok(!query.errors?.length, JSON.stringify(query));
		return query.data.affectedPackages.items
			.map((item: { path: string }) => item.path)
			.filter((path: string) => path !== "" && path !== "." && path !== "//")
			.toSorted();
	};
	return {
		root,
		write,
		run,
		commit,
		select,
		queryPaths,
		cleanup: () => {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function expectSelection(
	f: ReturnType<typeof fixture>,
	selected: string[],
	rust: boolean,
	js = false,
) {
	const { result, flags } = f.select();
	assert.equal(result.status, 0, result.stderr);
	for (const lane of lanes) assert.equal(flags[lane], String(selected.includes(lane)), lane);
	assert.equal(flags["rust"], String(rust));
	assert.equal(flags["js"], String(js));
	return flags;
}

test.runIf(nativeTests).each([
	[
		"Dispatcher",
		"apps/dispatcher/src/lib.rs",
		["apps/box-agent", "apps/control-plane", "apps/dispatcher"],
		["dispatcher-rust", "box-agent-rust", "control-plane-rust"],
		true,
	],
	[
		"Point core",
		"apps/point/core/src/lib.rs",
		["apps/point/core", "apps/point/server"],
		["point"],
		true,
	],
	[
		"native docs do not enable Rust CodeQL",
		"apps/dispatcher/notes.txt",
		["apps/box-agent", "apps/control-plane", "apps/dispatcher"],
		["dispatcher-rust", "box-agent-rust", "control-plane-rust"],
		false,
	],
] as const)("real Cargo/Turbo graph and CLI: %s", (_name, path, affected, selected, rust) => {
	const f = fixture();
	try {
		f.write(path, path.endsWith(".rs") ? "pub fn changed() {}\n" : "changed\n");
		f.commit();
		assert.deepEqual(f.queryPaths(), [...affected]);
		expectSelection(f, [...selected], rust);
		assert.match(readFileSync(join(f.root, "rustup.log"), "utf8"), /toolchain install/u);
	} finally {
		f.cleanup();
	}
});

test.runIf(nativeTests).each(["delete", "rename"])(
	"native %s preserves old path and graph consumers",
	(operation) => {
		const f = fixture();
		try {
			if (operation === "delete") f.run("git", ["rm", "apps/dispatcher/src/movable.rs"]);
			else f.run("git", ["mv", "apps/dispatcher/src/movable.rs", "apps/manager/src/moved.rs"]);
			f.commit();
			const selected = [
				"dispatcher-rust",
				"box-agent-rust",
				"control-plane-rust",
				...(operation === "rename" ? ["manager-rust"] : []),
			];
			assert.deepEqual(f.queryPaths(), [
				"apps/box-agent",
				"apps/control-plane",
				"apps/dispatcher",
				...(operation === "rename" ? ["apps/manager"] : []),
			]);
			expectSelection(f, selected, true);
		} finally {
			f.cleanup();
		}
	},
);

test
	.runIf(nativeTests)
	.each(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".github/actions/setup/action.yml"])(
	"full native input %s selects every lane",
	(path) => {
		const f = fixture();
		try {
			const previous = existsSync(join(f.root, path))
				? readFileSync(join(f.root, path), "utf8")
				: "";
			f.write(path, `${previous}\n# changed\n`);
			f.commit();
			assert.equal(f.queryPaths().includes("apps/web"), path === "Cargo.lock");
			expectSelection(f, lanes, true, path === "Cargo.lock");
			assert.equal(existsSync(join(f.root, "rustup.log")), true);
		} finally {
			f.cleanup();
		}
	},
);

test.runIf(nativeTests).each(["Flutter", "bridge", "JS"])(
	"%s-only selection has independent lanes/scans and Rust-free JS execution",
	(kind) => {
		const f = fixture();
		try {
			f.write(
				kind === "JS"
					? "apps/web/index.ts"
					: kind === "bridge"
						? "apps/point/app/lib/src/rust/bridge_generated.dart"
						: "apps/point/app/lib/main.dart",
				"// changed\n",
			);
			f.commit();
			const flags = expectSelection(f, kind === "JS" ? [] : ["point"], false, kind === "JS");
			if (kind === "JS") {
				for (const tool of ["cargo", "rustc", "rustup"])
					f.write(`bin/${tool}`, `#!/bin/sh\necho unexpected-${tool} >&2\nexit 97\n`, true);
				const env = { JS_PACKAGES_JSON: flags["js-packages"] ?? "" };
				assert.match(f.run(process.execPath, [cli, "build"], env), /@petalnet\/web:build/u);
				assert.match(f.run(process.execPath, [cli, "test"], env), /@petalnet\/web:test/u);
			}
		} finally {
			f.cleanup();
		}
	},
);

test.each([
	[
		"reported errors",
		0,
		'{"data":{"affectedPackages":{"items":[]}},"errors":[{"message":"query failure"}]}',
	],
	["nonzero exit", 7, '{"data":{"affectedPackages":{"items":[]}}}'],
	["invalid JSON", 0, "{"],
	["null data", 0, '{"data":null}'],
	["invalid path", 0, '{"data":{"affectedPackages":{"items":[{"name":"dispatcher","path":42}]}}}'],
	[
		"unsafe JS filter",
		0,
		'{"data":{"affectedPackages":{"items":[{"name":"@petalnet/grove...","path":"apps/web"}]}}}',
	],
] as const)("affected query %s fails closed before GITHUB_OUTPUT", (_name, exit, query) => {
	const f = fixture();
	try {
		f.write("apps/dispatcher/src/lib.rs", "pub fn changed() {}\n");
		f.commit();
		f.write(
			"bin/pnpm",
			`#!/bin/sh\ncase "$*" in\n*"query affected"*) printf '%s\\n' '${query}'; exit ${String(exit)};;\n*) printf '%s\\n' '{"tasks":[]}' ;;\nesac\n`,
			true,
		);
		const { result, output } = f.select();
		assert.notEqual(result.status, 0, result.stdout);
		assert.equal(output, "");
	} finally {
		f.cleanup();
	}
});
