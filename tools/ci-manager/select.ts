import { Config, Console, Effect, FileSystem, Record, Schema } from "effect";
import type { PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { codeqlSelection, nativeApps, nativeSelection } from "./policy.ts";
import { commandOutput, type CommandFailed } from "./process.ts";

const Event = Schema.Struct({
	pull_request: Schema.optionalKey(Schema.Struct({ base: Schema.Struct({ sha: Schema.String }) })),
	merge_group: Schema.optionalKey(Schema.Struct({ base_sha: Schema.String })),
});

const TurboPlan = Schema.Struct({
	tasks: Schema.Array(Schema.Struct({ command: Schema.String, task: Schema.String })),
});

export const select: Effect.Effect<
	void,
	Config.ConfigError | Schema.SchemaError | PlatformError.PlatformError | CommandFailed,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const eventPath = yield* Config.String("GITHUB_EVENT_PATH");
	const outputPath = yield* Config.String("GITHUB_OUTPUT");
	const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Event))(
		yield* fs.readFileString(eventPath),
	);
	const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha;
	let native: ReturnType<typeof nativeSelection>;
	let js = true;
	let scans = { "codeql-js": true, "codeql-python": true, actions: true };
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
		native = nativeSelection(paths);
		scans = codeqlSelection(paths);
		const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TurboPlan))(
			yield* commandOutput(
				"pnpm",
				["exec", "node", "tools/turbo-js.mjs", "run", "build", "test", "--affected", "--dry=json"],
				{
					TURBO_SCM_BASE: base,
					TURBO_SCM_HEAD: "HEAD",
				},
			),
		);
		js = plan.tasks.some(
			(task) => task.command !== "<NONEXISTENT>" && (task.task === "build" || task.task === "test"),
		);
	} else {
		// Main and manual runs always execute the complete validation suite.
		native = {
			...Record.map(nativeApps, () => true),
			rust: true,
		};
	}
	const outputs = {
		...native,
		...scans,
		js,
		base: base ?? "",
		affected: Boolean(base),
	};
	const lines = Object.entries(outputs)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("\n");
	yield* Console.log(lines);
	yield* fs.writeFileString(outputPath, `${lines}\n`, { flag: "a" });
});
