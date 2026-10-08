import { Config, Console, Effect, Schema } from "effect";

import { commandOutput } from "./process.ts";

export const WorkspacePackage = Schema.String.check(
	Schema.isPattern(/^@petalnet\/(?!.*\.\.\.)[a-z0-9][a-z0-9._-]*(?![\s\S])/u),
);

export const runTasks = Effect.fn("runTasks")(function* (task: "build" | "test") {
	const packages = yield* Schema.decodeEffect(
		Schema.fromJsonString(Schema.NonEmptyArray(WorkspacePackage)),
	)(yield* Config.String("JS_PACKAGES_JSON"));
	const output = yield* commandOutput("pnpm", [
		"exec",
		"turbo",
		"run",
		task,
		...packages.map((name) => `--filter=${name}`),
	]);
	yield* Console.log(output);
});
