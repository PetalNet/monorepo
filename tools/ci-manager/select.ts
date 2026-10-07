import { Config, Console, Effect, FileSystem, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { nativeApps, nativeSelection, QueueRuns, queueAlreadyCheckedFormatting } from "./policy.ts";
import { commandOutput } from "./process.ts";

const Event = Schema.Struct({
	pull_request: Schema.optionalKey(Schema.Struct({ base: Schema.Struct({ sha: Schema.String }) })),
	merge_group: Schema.optionalKey(Schema.Struct({ base_sha: Schema.String })),
});

const TurboPlan = Schema.Struct({
	tasks: Schema.Array(Schema.Struct({ command: Schema.String, task: Schema.String })),
});

// Formatting is only redundant when this exact commit passed the full merge-queue workflow.
// Missing permission/network/history is not evidence: keep checking formatting in that case.
const formattingRequired = Effect.gen(function* () {
	const eventName = yield* Config.String("GITHUB_EVENT_NAME").pipe(Config.withDefault(""));
	if (eventName !== "push") return true;
	const repository = yield* Config.String("GITHUB_REPOSITORY");
	const head = yield* Config.String("GITHUB_SHA");
	const output = yield* commandOutput("gh", [
		"api",
		`repos/${repository}/actions/workflows/ci.yml/runs`,
		"--method",
		"GET",
		"-f",
		"event=merge_group",
		"-f",
		`head_sha=${head}`,
		"-f",
		"status=success",
		"-f",
		"per_page=100",
	]);
	const runs = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(QueueRuns))(output);
	return !queueAlreadyCheckedFormatting(runs, head);
}).pipe(Effect.orElseSucceed(() => true));

export const select: Effect.Effect<
	void,
	unknown,
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
		native = nativeSelection(diff.split("\0").filter(Boolean));
		const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TurboPlan))(
			yield* commandOutput(
				"pnpm",
				["exec", "turbo", "run", "build", "test", "--affected", "--dry=json"],
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
			...Object.fromEntries(Object.keys(nativeApps).map((job) => [job, true])),
			rust: true,
		};
	}
	const outputs = {
		...native,
		js,
		base: base ?? "",
		affected: Boolean(base),
		format: yield* formattingRequired,
	};
	const lines = Object.entries(outputs)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("\n");
	yield* Console.log(lines);
	yield* fs.writeFileString(outputPath, `${lines}\n`, { flag: "a" });
});
