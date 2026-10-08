// oxlint-disable effecttsgo/unstable-api-usage -- The selector requires Effect 4's unstable process service.
import { Config, Console, Effect, FileSystem, Record, Schema } from "effect";
import type { PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { selectJobs } from "./policy.ts";
import { commandOutput, type CommandFailed } from "./process.ts";
import { WorkspacePackage } from "./run.ts";
import { Selection } from "./workflow.ts";

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

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a class factory, not a constructor.
class TurboQueryFailed extends Schema.TaggedError<TurboQueryFailed>()("TurboQueryFailed", {
	message: Schema.String,
}) {}

const affectedPackages = Effect.fn("affectedPackages")(function* (base: string) {
	yield* commandOutput("rustup", ["toolchain", "install"]);
	const graph = yield* Schema.decodeEffect(Schema.fromJsonString(AffectedPlan))(
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
	return graph.data.affectedPackages.items;
});

const workspaceTasks = Effect.fn("workspaceTasks")(function* (
	items: typeof AffectedPlan.Type.data.affectedPackages.items,
) {
	const packages = yield* Schema.decodeEffect(Schema.Array(WorkspacePackage))(
		items.map((item) => item.name).filter((name) => name.startsWith("@petalnet/")),
	);
	const plan =
		packages.length > 0
			? yield* Schema.decodeEffect(Schema.fromJsonString(TurboPlan))(
					yield* commandOutput("pnpm", [
						"exec",
						"turbo",
						"run",
						"build",
						"test",
						...packages.map((name) => `--filter=${name}`),
						"--dry=json",
					]),
				)
			: { tasks: [] };
	return {
		js: plan.tasks.some(
			(task) => task.command !== "<NONEXISTENT>" && (task.task === "build" || task.task === "test"),
		),
		"js-packages": JSON.stringify(packages),
	};
});

const comparisonPlan = Effect.fn("comparisonPlan")(function* (base: string) {
	// Both rename sides participate; package querying is independent of this diff.
	const [diff, items] = yield* Effect.all(
		[
			commandOutput("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"]),
			affectedPackages(base),
		],
		{ concurrency: 2 },
	);
	return {
		...selectJobs(
			diff.split("\0").filter(Boolean),
			items.map((item) => item.path),
		),
		...(yield* workspaceTasks(items)),
		affected: true,
	};
});

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
	const event = yield* Schema.decodeEffect(Schema.fromJsonString(Event))(
		yield* fs.readFileString(eventPath),
	);
	const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha;
	const outputs = base
		? yield* comparisonPlan(base)
		: { ...Record.map(Selection.fields, () => true), "js-packages": "[]", affected: false };
	const lines = Object.entries(outputs)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("\n");
	yield* Console.log(lines);
	yield* fs.writeFileString(outputPath, `${lines}\n`, { flag: "a" });
});
