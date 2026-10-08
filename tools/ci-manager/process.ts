// oxlint-disable effecttsgo/unstable-api-usage -- Effect 4 exposes process services through unstable APIs.
import { Console, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a class factory, not a constructor.
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
	command: Schema.String,
	exitCode: Schema.Int,
}) {}

// Collect stdout separately from diagnostics, and never accept output from a failed command.
export const commandOutput = Effect.fn("commandOutput")(function* (
	command: string,
	args: readonly string[],
	env?: Record<string, string>,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(
		ChildProcess.make(command, args, { env, extendEnv: true, stderr: "inherit" }),
	);
	const output = yield* Stream.mkString(Stream.decodeText(handle.stdout));
	const exitCode = yield* handle.exitCode;
	if (exitCode !== 0) {
		yield* Console.error(output);
		return yield* new CommandFailed({ command, exitCode });
	}
	return output;
}, Effect.scoped);
