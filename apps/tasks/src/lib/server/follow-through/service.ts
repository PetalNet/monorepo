import { spawn } from "node:child_process";

import { Context, Data, Effect, Layer, Schema } from "effect";

import { Snapshot } from "../../follow-through-schema.ts";

export class FollowThroughUnavailable extends Data.TaggedError("FollowThroughUnavailable") {}
export class FollowThroughDenied extends Data.TaggedError("FollowThroughDenied") {}
export class FollowThroughViewer extends Context.Service<FollowThroughViewer, { user: string }>()(
	"tasks/FollowThroughViewer",
) {}

type Command =
	| { action: "snapshot" | "pause" | "resume" }
	| { action: "drop"; id: number; reason: string }
	| { action: "snooze"; id: number; hours: number };
export class FollowThrough extends Context.Service<
	FollowThrough,
	{
		execute: (
			command: Command,
		) => Effect.Effect<
			Snapshot,
			FollowThroughUnavailable | FollowThroughDenied,
			FollowThroughViewer
		>;
	}
>()("tasks/FollowThrough") {}

/** A fixed administrator-configured argv, never a shell command or request-supplied path. */
function runControl(argv: readonly string[], command: Command): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const [executable, ...args] = argv;

		if (!executable) {
			reject(new Error("unconfigured"));

			return;
		}

		const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		let size = 0;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("timeout"));
		}, 10_000);

		child.on("error", () => {
			clearTimeout(timer);
			reject(new Error("unavailable"));
		});

		child.stdin.on("error", () => {
			child.kill("SIGKILL");
			reject(new Error("unavailable"));
		});

		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;

			if (size > 1024 * 1024) {
				child.kill("SIGKILL");
				reject(new Error("too-large"));
			} else {
				chunks.push(chunk);
			}
		});

		child.on("close", (code) => {
			clearTimeout(timer);

			if (code !== 0) {
				reject(new Error("unavailable"));

				return;
			}

			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new Error("invalid-response"));
			}
		});

		child.stdin.end(JSON.stringify(command));
	});
}

function followThroughLayer(argv: readonly string[], operators: readonly string[]) {
	return Layer.succeed(FollowThrough, {
		execute: (command) =>
			Effect.gen(function* () {
				const viewer = yield* FollowThroughViewer;

				if (!operators.includes(viewer.user)) {
					return yield* new FollowThroughDenied();
				}

				const raw = yield* Effect.tryPromise({
					try: () => runControl(argv, command),
					catch: () => new FollowThroughUnavailable(),
				});

				return yield* Schema.decodeUnknownEffect(Snapshot)(raw).pipe(
					Effect.mapError(() => new FollowThroughUnavailable()),
				);
			}),
	});
}

function configuredCommand(): string[] {
	try {
		const raw: unknown = JSON.parse(process.env.FOLLOW_THROUGH_COMMAND_ARGV ?? "[]");

		return Array.isArray(raw) &&
			raw.every((value: unknown): value is string => typeof value === "string" && value.length > 0)
			? raw
			: [];
	} catch {
		return [];
	}
}

export const FollowThroughLive = followThroughLayer(
	configuredCommand(),
	(process.env.FOLLOW_THROUGH_OPERATORS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean),
);
