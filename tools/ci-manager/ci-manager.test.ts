import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { assert, expect, test } from "vitest";

import { evaluateGate } from "./gate.ts";
import { selectJobs } from "./policy.ts";
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
	"root-check": { result: "success" },
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

const gateCases = scenarios.map((scenario) => {
	const jobs: Record<string, { result: string; outputs?: Record<string, string> }> = {
		...required,
		select: { result: "success", outputs: scenario.selection },
		check: { result: scenario.selection.js === "true" ? "success" : "skipped" },
		...Object.fromEntries(
			Object.entries(scenario.results).map(([job, result]) => [job, { result }]),
		),
	};
	return { ...scenario, jobs };
});

it.effect.each(gateCases)("$name: exact expected conclusions pass", ({ jobs }) =>
	Effect.gen(function* () {
		const conclusions = yield* evaluateGate(JSON.stringify(jobs));
		assert.equal(conclusions.length, 18);
	}),
);

const jobCases = gateCases.flatMap((scenario) =>
	Object.entries(scenario.jobs).map(([job, expected]) => ({ ...scenario, job, expected })),
);

it.effect.each(
	jobCases.flatMap((entry) =>
		["success", "failure", "cancelled", "skipped"]
			.filter((result) => result !== entry.expected.result)
			.map((result) => ({ ...entry, result })),
	),
)("$name: rejects $job=$result", ({ jobs, job, expected, result }) =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(
			evaluateGate(JSON.stringify({ ...jobs, [job]: { ...expected, result } })),
		);
		expect(error).toMatchObject({ _tag: "GateFailed" });
		expect(error.message).toMatch(/expected .*got/u);
	}),
);

it.effect.each(jobCases)("$name: rejects missing $job", ({ jobs, job }) =>
	Effect.gen(function* () {
		const missing = Object.fromEntries(Object.entries(jobs).filter(([name]) => name !== job));
		const error = yield* Effect.flip(evaluateGate(JSON.stringify(missing)));
		expect(error).toBeInstanceOf(Error);
	}),
);

it.effect.each(
	gateCases.flatMap((scenario) =>
		Object.keys(scenario.selection).map((key) => ({ ...scenario, key })),
	),
)("$name: rejects malformed $key selection", ({ jobs, selection, key }) =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(
			evaluateGate(
				JSON.stringify({
					...jobs,
					select: { result: "success", outputs: { ...selection, [key]: "yes" } },
				}),
			),
		);
		expect(error).toBeInstanceOf(Error);
	}),
);

it.effect.each(
	gateCases.flatMap((scenario) => ["new-job", "constructor"].map((job) => ({ ...scenario, job }))),
)("$name: rejects unclassified $job", ({ jobs, job }) =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(
			evaluateGate(JSON.stringify({ ...jobs, [job]: { result: "success" } })),
		);
		expect(error).toMatchObject({ _tag: "GateFailed" });
		expect(error.message).toMatch(/Unclassified job/u);
	}),
);

it.effect.each(["{", "null", JSON.stringify({ select: { result: "unknown" } })])(
	"malformed gate input %s fails decoding",
	(json) =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(evaluateGate(json));
			expect(error).toBeInstanceOf(Error);
		}),
);

const appJobs = [
	"manager-rust",
	"courier-rust",
	"dispatcher-rust",
	"control-plane-rust",
	"box-agent-rust",
	"point",
];
const selectionKeys = [...appJobs, "codeql-js", "codeql-python", "actions", "rust"];

test.for([
	["documentation and synthetic workspace", ["README.md"], [""], []],
	["workspace inputs", ["apps/grove/src/routes/+page.svelte", "pnpm-lock.yaml"], [], ["codeql-js"]],
	["Point Flutter inputs", ["apps/point/app/lib/main.dart"], [], ["point"]],
	["Point web inputs", ["apps/point/app/web/index.html"], [], ["point", "codeql-js"]],
	["Point bridge inputs", ["apps/point/app/rust/src/lib.rs"], [], ["point", "rust"]],
	[
		"Dispatcher consumers",
		["apps/dispatcher/src/lib.rs"],
		["", "apps/dispatcher", "apps/box-agent", "apps/control-plane"],
		["dispatcher-rust", "box-agent-rust", "control-plane-rust", "rust"],
	],
	["root Cargo", ["Cargo.lock"], [], [...appJobs, "rust"]],
	["Cargo configuration", [".cargo/config.toml"], [], [...appJobs, "rust"]],
	["Turbo configuration", ["turbo.json"], [], [...appJobs, "codeql-js"]],
	["Actions workflow", [".github/workflows/point-release.yml"], [], [...appJobs, "actions"]],
	["shared selector", ["tools/ci-manager/policy.ts"], [], selectionKeys],
	["shared setup", [".github/actions/setup/action.yml"], [], selectionKeys],
	["unrelated Github documentation", [".github/README.md"], [], []],
	[
		"Python source",
		["apps/manager/docs/contracts/validate.py"],
		[],
		["manager-rust", "codeql-python"],
	],
	[
		"Python schemas",
		["apps/manager/docs/contracts/schemas/task-card.schema.json"],
		[],
		["manager-rust", "codeql-python"],
	],
	...[
		"tools/view.html.erb",
		"tools/view.html.dot",
		"tools/query.xsjslib",
		"tools/code.es6",
		"tools/view.xhtm",
	].map((path) => [path, [path], [], ["codeql-js"]] as const),
	["non-extracted template extension", ["tools/view.erb"], [], []],
	...[
		"tools/source.pyw",
		"types.pyi",
		"pyproject.toml",
		"requirements-dev.txt",
		"constraints.txt",
		"Pipfile.lock",
		"poetry.lock",
		"uv.lock",
		"setup.cfg",
		"tox.ini",
		".python-version",
	].map((path) => [path, [path], [], ["codeql-python"]] as const),
	...["packages/tsconfig/base.json", "tsconfig.eslint.json", ".npmrc", "pnpm-workspace.yaml"].map(
		(path) => [path, [path], [], ["codeql-js"]] as const,
	),
] as const)("workflow rules: %s", ([, paths, packages, enabled]) => {
	assert.deepEqual(
		selectJobs(paths, packages),
		Object.fromEntries(selectionKeys.map((key) => [key, enabled.some((job) => job === key)])),
	);
});

it.live("command output cannot hide a nonzero exit behind valid JSON", () =>
	Effect.gen(function* () {
		const printJson = "process.stdout.write(JSON.stringify({ tasks: [] }))";
		const output = yield* commandOutput(process.execPath, ["-e", printJson]);
		assert.equal(output, '{"tasks":[]}');
		const error = yield* Effect.flip(
			commandOutput(process.execPath, ["-e", `${printJson}; process.exit(7)`]),
		);
		expect(error).toMatchObject({ _tag: "CommandFailed", command: process.execPath, exitCode: 7 });
	}).pipe(Effect.provide(NodeServices.layer)),
);
