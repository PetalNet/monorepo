import { Record, Schema } from "effect";

// Keep these keys identical to the native job IDs in ci.yml.
export const nativeApps = {
	"manager-rust": "manager",
	"courier-rust": "courier",
	"dispatcher-rust": "dispatcher",
	"control-plane-rust": "control-plane",
	"box-agent-rust": "box-agent",
	point: "point",
} as const;

export const QueueRuns = Schema.Struct({
	workflow_runs: Schema.Array(
		Schema.Struct({
			event: Schema.String,
			head_sha: Schema.String,
			conclusion: Schema.NullOr(Schema.String),
		}),
	),
});

export function nativeSelection(paths: readonly string[]) {
	const shared = paths.some(
		(path) =>
			path.startsWith(".github/workflows/") ||
			path.startsWith(".github/actions/") ||
			path.startsWith(".github/codeql/") ||
			path.startsWith("tools/ci-manager/") ||
			path === "tools/turbo-js.mjs" ||
			/^mise\.(?:toml|lock)$/u.test(path),
	);
	// Rust apps have cross-app dependencies: a Rust input selects every native lane.
	const rust =
		shared ||
		paths.some((path) =>
			/(?:\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$|(?:^|\/)rust-toolchain(?:\.toml)?$|(?:^|\/)\.cargo\/)/u.test(
				path,
			),
		);
	const apps = Record.map(
		nativeApps,
		(app) => rust || paths.some((path) => path.startsWith(`apps/${app}/`)),
	);
	return { ...apps, rust };
}

export function queueAlreadyCheckedFormatting(runs: typeof QueueRuns.Type, head: string) {
	return runs.workflow_runs.some(
		(run) => run.event === "merge_group" && run.head_sha === head && run.conclusion === "success",
	);
}
