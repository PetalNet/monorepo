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
	tasks: Schema.Array(
		Schema.Struct({
			command: Schema.String,
			task: Schema.String,
			cache: Schema.Struct({ status: Schema.Literals(["HIT", "MISS"]) }),
			resolvedTaskDefinition: Schema.Struct({ cache: Schema.Boolean }),
		}),
	),
});

export function needsExecution(plan: typeof TurboPlan.Type) {
	return plan.tasks.some(
		(task) =>
			task.command !== "<NONEXISTENT>" &&
			(!task.resolvedTaskDefinition.cache || task.cache.status !== "HIT"),
	);
}

const rustPackages = {
	"manager-rust": {
		filter: "agent-manager",
		tasks: ["fmt:check", "check", "lint", "test", "test:tmux"],
	},
	"courier-rust": { filter: "courier*", tasks: ["fmt:check", "check", "lint", "build", "test"] },
	"dispatcher-rust": { filter: "dispatcher", tasks: ["fmt:check", "check", "lint", "test"] },
	"control-plane-rust": { filter: "control-plane", tasks: ["fmt:check", "check", "lint", "test"] },
	"box-agent-rust": { filter: "box-agent", tasks: ["fmt:check", "check", "lint", "test"] },
	point: { filter: "point-*", tasks: ["fmt:check", "check", "lint", "build", "test"] },
} as const;

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
	items?: typeof AffectedPlan.Type.data.affectedPackages.items,
) {
	const fs = yield* FileSystem.FileSystem;
	const packages = yield* Schema.decodeEffect(Schema.Array(WorkspacePackage))(
		items?.map((item) => item.name).filter((name) => name.startsWith("@petalnet/")) ?? [],
	);
	if (items && packages.length === 0) {
		return { js: false, build: false, test: false, "js-packages": "[]" };
	}
	const filters = items ? packages.map((name) => `--filter=${name}`) : ["--filter=@petalnet/*"];
	const plan = (task: "build" | "test", env?: Record<string, string>) =>
		commandOutput("pnpm", ["exec", "turbo", "run", task, ...filters, "--dry=json"], env).pipe(
			Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TurboPlan))),
		);
	const test = yield* plan("test");
	// Match the build job's database environment and dotenv inputs, then restore the checkout.
	const databaseUrl = "file:/tmp/build.db";
	const backups = yield* Effect.forEach(["apps/collegemap", "apps/grove"], (directory) =>
		Effect.gen(function* () {
			if (!(yield* fs.exists(directory))) {
				return [];
			}
			const path = `${directory}/.env`;
			return [{ path, contents: (yield* fs.exists(path)) ? yield* fs.readFileString(path) : null }];
		}),
	).pipe(Effect.map((entries) => entries.flat()));
	const build = yield* Effect.gen(function* () {
		yield* Effect.forEach(backups, ({ path }) =>
			fs.writeFileString(path, `DATABASE_URL=${databaseUrl}\n`),
		);
		return yield* plan("build", { DATABASE_URL: databaseUrl });
	}).pipe(
		Effect.ensuring(
			Effect.forEach(backups, ({ path, contents }) =>
				contents === null ? fs.remove(path, { force: true }) : fs.writeFileString(path, contents),
			).pipe(Effect.orDie),
		),
	);
	return {
		js: [...build.tasks, ...test.tasks].some(
			(task) => task.command !== "<NONEXISTENT>" && (task.task === "build" || task.task === "test"),
		),
		build: needsExecution(build),
		test: needsExecution(test),
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
	yield* commandOutput("rustup", ["toolchain", "install"]);
	const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha;
	const decisions = base
		? yield* comparisonPlan(base)
		: {
				...Record.map(Selection.fields, () => true),
				...(yield* workspaceTasks()),
				affected: false,
			};
	// Main/manual runs also consult the cache; uncached tasks remain selected.
	const rust = yield* Effect.forEach(Record.toEntries(rustPackages), ([owner, { filter, tasks }]) =>
		Effect.gen(function* () {
			const job = owner === "point" ? "point-rust" : owner;
			if (!decisions[owner]) {
				return [job, false] as const;
			}
			const plan = yield* Schema.decodeEffect(Schema.fromJsonString(TurboPlan))(
				yield* commandOutput(
					"pnpm",
					["exec", "turbo", "run", ...tasks, `--filter=${filter}`, "--dry=json"],
					job === "point-rust"
						? {
								DATABASE_URL: "postgres://point:point@localhost:5432/point_test",
							}
						: undefined,
				),
			);
			return [job, needsExecution(plan)] as const;
		}),
	);
	const outputs = { ...decisions, ...Object.fromEntries(rust) };
	const lines = Object.entries(outputs)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("\n");
	yield* Console.log(lines);
	yield* fs.writeFileString(outputPath, `${lines}\n`, { flag: "a" });
});
