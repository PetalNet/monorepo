import { Config, Console, Effect, FileSystem, Record, Schema } from "effect";
import type { PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import {
	codeqlSelection,
	nativeApps,
	nativeSelection,
	type CodeQLSelection,
	type NativeSelection,
} from "./policy.ts";
import { commandOutput, type CommandFailed } from "./process.ts";
import { JSPackage } from "./run.ts";

const Event = Schema.Struct({
	pull_request: Schema.optionalKey(Schema.Struct({ base: Schema.Struct({ sha: Schema.String }) })),
	merge_group: Schema.optionalKey(Schema.Struct({ base_sha: Schema.String })),
});

const TurboPlan = Schema.Struct({
	tasks: Schema.Array(Schema.Struct({ command: Schema.String, task: Schema.String })),
});

const AffectedPlan = Schema.Struct({
	data: Schema.Struct({
		affectedPackages: Schema.Struct({
			items: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
		}),
	}),
	errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

class TurboQueryFailed extends Schema.TaggedError<TurboQueryFailed>()("TurboQueryFailed", {
	message: Schema.String,
}) {}

export const select: Effect.Effect<
	void,
	| Config.ConfigError
	| Schema.SchemaError
	| PlatformError.PlatformError
	| CommandFailed
	| TurboQueryFailed,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const eventPath = yield* Config.String("GITHUB_EVENT_PATH");
	const outputPath = yield* Config.String("GITHUB_OUTPUT");
	const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Event))(
		yield* fs.readFileString(eventPath),
	);
	const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha;
	let native: NativeSelection;
	let js = true;
	let packages: readonly string[] = [];
	let scans: CodeQLSelection = {
		"codeql-js": true,
		"codeql-python": true,
		actions: true,
		rust: true,
	};
	if (base) {
		// Disable rename detection so both deletion and addition participate in selection.
		const diff = yield* commandOutput("git", [
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			base,
			"HEAD",
		]);
		const paths = diff.split("\0").filter(Boolean);
		scans = codeqlSelection(paths);
		yield* commandOutput("rustup", ["toolchain", "install"]);
		const graph = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AffectedPlan))(
			yield* commandOutput("pnpm", [
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
		if (graph.errors?.length) {
			return yield* new TurboQueryFailed({
				message: graph.errors.map((error) => error.message).join("\n"),
			});
		}
		native = nativeSelection(
			paths,
			graph.data.affectedPackages.items.map((item) => item.path),
		);
		packages = yield* Schema.decodeUnknownEffect(Schema.Array(JSPackage))(
			graph.data.affectedPackages.items
				.map((item) => item.name)
				.filter((name) => name.startsWith("@petalnet/")),
		);
		js = false;
		if (packages.length) {
			const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TurboPlan))(
				yield* commandOutput("pnpm", [
					"exec",
					"turbo",
					"run",
					"build",
					"test",
					...packages.map((name) => `--filter=${name}`),
					"--dry=json",
				]),
			);
			js = plan.tasks.some(
				(task) =>
					task.command !== "<NONEXISTENT>" && (task.task === "build" || task.task === "test"),
			);
		}
	} else {
		// Main and manual runs always execute the complete validation suite.
		native = Record.map(nativeApps, () => true);
	}
	const outputs = {
		...native,
		...scans,
		js,
		"js-packages": JSON.stringify(packages),
		affected: Boolean(base),
	};
	const lines = Object.entries(outputs)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("\n");
	yield* Console.log(lines);
	yield* fs.writeFileString(outputPath, `${lines}\n`, { flag: "a" });
});
